#Requires -Version 7.0
<#
.SYNOPSIS
    Upload large OS bundles (12.5 GB) to a new GitHub repository with Git LFS.

.DESCRIPTION
    This script:
    1. Creates a new GitHub repository
    2. Configures Git LFS patterns BEFORE adding files (critical for proper tracking)
    3. Uploads all files with LFS for anything over 50MB
    4. Provides progress reporting and receipts

.NOTES
    Source folder: C:\Users\User\Downloads\OS and large files
    Expected size: ~12.5 GB, ~90 files

    IMPORTANT: Git LFS has storage/bandwidth limits:
    - Free tier: 1 GB storage, 1 GB/month bandwidth
    - You may need GitHub LFS data packs for this upload size

    SEE PRINCIPLES APPLIED:
    - LFS patterns committed BEFORE files added (fixes BUG-003)
    - Uses 50MB threshold (GitHub recommendation, not just 100MB hard limit)
    - All operations logged to receipt
    - Fail-closed on errors
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ============================================================
# CONFIGURATION (USER-LOCKED)
# ============================================================

$SourceFolder = "C:\Users\User\Downloads\OS and large files"
$RepoName = "metablooms-os-bundles"
$RepoDescription = "MetaBlooms OS Distribution Bundles"
$RepoVisibility = "private"  # Change to "public" if needed

# GitHub recommends LFS for files > 50MB, hard blocks > 100MB
$LfsThresholdBytes = 50MB

# ============================================================
# PREFLIGHT CHECKS (FAIL CLOSED)
# ============================================================

Write-Host ""
Write-Host "=" * 60 -ForegroundColor Cyan
Write-Host "  METABLOOMS OS BUNDLE UPLOADER" -ForegroundColor Cyan
Write-Host "  12.5 GB / 90 files -> GitHub with LFS" -ForegroundColor Cyan
Write-Host "=" * 60 -ForegroundColor Cyan
Write-Host ""

function Require-Command([string]$cmd, [string]$fix) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        throw "Missing required tool: $cmd. Fix: $fix"
    }
    Write-Host "[OK] $cmd found" -ForegroundColor Green
}

function Format-Bytes([long]$bytes) {
    if ($bytes -ge 1GB) { return "{0:N2} GB" -f ($bytes / 1GB) }
    if ($bytes -ge 1MB) { return "{0:N2} MB" -f ($bytes / 1MB) }
    if ($bytes -ge 1KB) { return "{0:N2} KB" -f ($bytes / 1KB) }
    return "$bytes bytes"
}

Write-Host "[1/8] PREFLIGHT CHECKS" -ForegroundColor Yellow
Write-Host "-" * 40

if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw "PowerShell 7+ required. Current: $($PSVersionTable.PSVersion)"
}
Write-Host "[OK] PowerShell $($PSVersionTable.PSVersion)" -ForegroundColor Green

Require-Command git "Install Git from https://git-scm.com"
Require-Command gh "Install GitHub CLI from https://cli.github.com"
Require-Command git-lfs "Install Git LFS from https://git-lfs.github.com"

# Check GitHub auth
Write-Host "Checking GitHub authentication..." -ForegroundColor Gray
$authResult = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "GitHub CLI not authenticated. Run: gh auth login"
}
Write-Host "[OK] GitHub CLI authenticated" -ForegroundColor Green

# Check source folder
if (-not (Test-Path $SourceFolder -PathType Container)) {
    throw "Source folder not found: $SourceFolder"
}
Write-Host "[OK] Source folder exists: $SourceFolder" -ForegroundColor Green

# ============================================================
# ANALYZE SOURCE FOLDER
# ============================================================

Write-Host ""
Write-Host "[2/8] ANALYZING SOURCE FOLDER" -ForegroundColor Yellow
Write-Host "-" * 40

$allFiles = Get-ChildItem -Path $SourceFolder -File -Recurse
$totalSize = ($allFiles | Measure-Object -Property Length -Sum).Sum
$fileCount = $allFiles.Count

$largeFiles = $allFiles | Where-Object { $_.Length -gt $LfsThresholdBytes }
$largeFileCount = $largeFiles.Count
$largeFileSize = ($largeFiles | Measure-Object -Property Length -Sum).Sum

$veryLargeFiles = $allFiles | Where-Object { $_.Length -gt 100MB }
$veryLargeCount = $veryLargeFiles.Count

Write-Host "Total files      : $fileCount"
Write-Host "Total size       : $(Format-Bytes $totalSize)"
Write-Host "Files > 50 MB    : $largeFileCount ($(Format-Bytes $largeFileSize)) -> LFS tracked"
Write-Host "Files > 100 MB   : $veryLargeCount (REQUIRE LFS or will be blocked)"

if ($veryLargeCount -gt 0) {
    Write-Host ""
    Write-Host "Files over 100 MB (will use LFS):" -ForegroundColor Magenta
    $veryLargeFiles | ForEach-Object {
        Write-Host "  - $($_.Name): $(Format-Bytes $_.Length)" -ForegroundColor Magenta
    }
}

# Get unique extensions for LFS patterns
$extensions = $allFiles |
    Where-Object { $_.Length -gt $LfsThresholdBytes } |
    ForEach-Object { $_.Extension.ToLower() } |
    Sort-Object -Unique

Write-Host ""
Write-Host "LFS extensions detected: $($extensions -join ', ')"

# ============================================================
# WARNING FOR LARGE UPLOADS
# ============================================================

Write-Host ""
Write-Host "WARNING: This upload is $(Format-Bytes $totalSize)" -ForegroundColor Red
Write-Host "GitHub LFS free tier: 1 GB storage, 1 GB/month bandwidth" -ForegroundColor Red
Write-Host "You may need to purchase LFS data packs." -ForegroundColor Red
Write-Host ""
Write-Host "Press ENTER to continue or Ctrl+C to abort..." -ForegroundColor Yellow
Read-Host

# ============================================================
# CREATE GITHUB REPOSITORY
# ============================================================

Write-Host ""
Write-Host "[3/8] CREATING GITHUB REPOSITORY" -ForegroundColor Yellow
Write-Host "-" * 40

# Check if repo already exists
$existingRepo = gh repo view "$RepoName" 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "Repository '$RepoName' already exists." -ForegroundColor Yellow
    Write-Host "Do you want to use the existing repo? (y/n)" -ForegroundColor Yellow
    $response = Read-Host
    if ($response -ne 'y') {
        throw "Aborted. Choose a different repo name."
    }
    $RepoUrl = (gh repo view $RepoName --json url -q .url)
} else {
    Write-Host "Creating new $RepoVisibility repository: $RepoName"
    gh repo create $RepoName --$RepoVisibility --description "$RepoDescription"
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create repository"
    }
    $RepoUrl = (gh repo view $RepoName --json url -q .url)
}

Write-Host "[OK] Repository ready: $RepoUrl" -ForegroundColor Green

# ============================================================
# SETUP LOCAL CLONE
# ============================================================

Write-Host ""
Write-Host "[4/8] SETTING UP LOCAL REPOSITORY" -ForegroundColor Yellow
Write-Host "-" * 40

$Timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$WorkDir = Join-Path $env:TEMP "os_bundle_upload_$Timestamp"

Write-Host "Working directory: $WorkDir"

git clone $RepoUrl $WorkDir
if ($LASTEXITCODE -ne 0) {
    throw "Failed to clone repository"
}

Set-Location $WorkDir
git lfs install
if ($LASTEXITCODE -ne 0) {
    throw "Failed to initialize Git LFS"
}

Write-Host "[OK] Repository cloned and LFS initialized" -ForegroundColor Green

# ============================================================
# CONFIGURE LFS PATTERNS *BEFORE* ADDING FILES
# (This is the critical fix for BUG-003)
# ============================================================

Write-Host ""
Write-Host "[5/8] CONFIGURING GIT LFS PATTERNS (BEFORE FILES)" -ForegroundColor Yellow
Write-Host "-" * 40
Write-Host "CRITICAL: LFS patterns must be committed BEFORE adding large files" -ForegroundColor Magenta

# Build comprehensive LFS patterns
$lfsPatterns = @(
    # By extension (common large file types)
    "*.zip filter=lfs diff=lfs merge=lfs -text"
    "*.7z filter=lfs diff=lfs merge=lfs -text"
    "*.tar filter=lfs diff=lfs merge=lfs -text"
    "*.gz filter=lfs diff=lfs merge=lfs -text"
    "*.tar.gz filter=lfs diff=lfs merge=lfs -text"
    "*.tgz filter=lfs diff=lfs merge=lfs -text"
    "*.rar filter=lfs diff=lfs merge=lfs -text"
    "*.iso filter=lfs diff=lfs merge=lfs -text"
    "*.img filter=lfs diff=lfs merge=lfs -text"
    "*.bin filter=lfs diff=lfs merge=lfs -text"
    "*.exe filter=lfs diff=lfs merge=lfs -text"
    "*.msi filter=lfs diff=lfs merge=lfs -text"
    "*.dmg filter=lfs diff=lfs merge=lfs -text"
    "*.pkg filter=lfs diff=lfs merge=lfs -text"
    "*.deb filter=lfs diff=lfs merge=lfs -text"
    "*.rpm filter=lfs diff=lfs merge=lfs -text"
    "*.whl filter=lfs diff=lfs merge=lfs -text"
    "*.pth filter=lfs diff=lfs merge=lfs -text"
    "*.onnx filter=lfs diff=lfs merge=lfs -text"
    "*.pt filter=lfs diff=lfs merge=lfs -text"
    "*.safetensors filter=lfs diff=lfs merge=lfs -text"
    "*.gguf filter=lfs diff=lfs merge=lfs -text"
    "*.db filter=lfs diff=lfs merge=lfs -text"
    "*.sqlite filter=lfs diff=lfs merge=lfs -text"
    "*.sqlite3 filter=lfs diff=lfs merge=lfs -text"
)

# Add patterns for extensions we detected
foreach ($ext in $extensions) {
    $pattern = "*$ext filter=lfs diff=lfs merge=lfs -text"
    if ($pattern -notin $lfsPatterns) {
        $lfsPatterns += $pattern
    }
}

# Add text normalization
$gitattributesContent = @"
# Git LFS patterns for large files
# Generated: $Timestamp
# Source: $SourceFolder
# Total files: $fileCount
# Files requiring LFS: $largeFileCount

# ============================================================
# LFS TRACKED PATTERNS (files over 50MB)
# ============================================================

$($lfsPatterns -join "`n")

# ============================================================
# TEXT FILE NORMALIZATION
# ============================================================

* text=auto

*.md text eol=lf
*.txt text eol=lf
*.json text eol=lf
*.yaml text eol=lf
*.yml text eol=lf
*.xml text eol=lf
*.csv text eol=lf
*.ps1 text eol=lf
*.sh text eol=lf
*.py text eol=lf

"@

$gitattributesPath = Join-Path $WorkDir ".gitattributes"
$gitattributesContent | Out-File -Encoding UTF8NoBOM $gitattributesPath

# CRITICAL: Commit .gitattributes BEFORE adding any other files
git add .gitattributes
git commit -m "Configure Git LFS patterns before upload

Timestamp: $Timestamp
Source: $SourceFolder
Total size: $(Format-Bytes $totalSize)
Files requiring LFS: $largeFileCount"

Write-Host "[OK] LFS patterns committed BEFORE file upload" -ForegroundColor Green

# ============================================================
# COPY FILES TO REPOSITORY
# ============================================================

Write-Host ""
Write-Host "[6/8] COPYING FILES TO REPOSITORY" -ForegroundColor Yellow
Write-Host "-" * 40

$destFolder = Join-Path $WorkDir "os_bundles"
New-Item -ItemType Directory -Force -Path $destFolder | Out-Null

$receipt = @{
    upload_id = $Timestamp
    repo = $RepoUrl
    source_folder = $SourceFolder
    total_files = $fileCount
    total_bytes = $totalSize
    lfs_threshold_bytes = $LfsThresholdBytes
    lfs_file_count = $largeFileCount
    files = @()
    started_at = (Get-Date).ToUniversalTime().ToString("o")
}

$copied = 0
foreach ($file in $allFiles) {
    $copied++
    $relativePath = $file.FullName.Substring($SourceFolder.Length).TrimStart('\', '/')
    $destPath = Join-Path $destFolder $relativePath

    # Ensure parent directory exists
    $destDir = Split-Path $destPath -Parent
    if (-not (Test-Path $destDir)) {
        New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    }

    # Copy file
    Copy-Item -Path $file.FullName -Destination $destPath -Force

    # Calculate hash
    $hash = (Get-FileHash -Path $destPath -Algorithm SHA256).Hash

    $isLfs = $file.Length -gt $LfsThresholdBytes

    $receipt.files += @{
        name = $file.Name
        relative_path = $relativePath
        bytes = $file.Length
        sha256 = $hash
        lfs = $isLfs
    }

    $pct = [math]::Round(($copied / $fileCount) * 100)
    $status = if ($isLfs) { "[LFS]" } else { "     " }
    Write-Host "`r[$pct%] $status Copied: $($file.Name) ($(Format-Bytes $file.Length))".PadRight(80) -NoNewline
}

Write-Host ""
Write-Host "[OK] All $fileCount files copied" -ForegroundColor Green

# ============================================================
# STAGE AND COMMIT
# ============================================================

Write-Host ""
Write-Host "[7/8] STAGING AND COMMITTING" -ForegroundColor Yellow
Write-Host "-" * 40

Write-Host "Staging files (this may take a while for large repos)..."
git add .

Write-Host "Creating commit..."
git commit -m "Upload OS bundles $Timestamp

Source: $SourceFolder
Total files: $fileCount
Total size: $(Format-Bytes $totalSize)
LFS tracked: $largeFileCount files ($(Format-Bytes $largeFileSize))

Upload script: SEE-compliant with LFS patterns pre-committed"

$CommitSha = (git rev-parse HEAD).Trim()
$receipt.commit = $CommitSha

Write-Host "[OK] Committed: $CommitSha" -ForegroundColor Green

# ============================================================
# PUSH TO GITHUB
# ============================================================

Write-Host ""
Write-Host "[8/8] PUSHING TO GITHUB" -ForegroundColor Yellow
Write-Host "-" * 40
Write-Host ""
Write-Host "Uploading $(Format-Bytes $totalSize) - this will take a while..." -ForegroundColor Magenta
Write-Host "LFS uploads: $largeFileCount files ($(Format-Bytes $largeFileSize))" -ForegroundColor Magenta
Write-Host ""

# Set longer timeout for large uploads
$env:GIT_HTTP_LOW_SPEED_LIMIT = "1000"
$env:GIT_HTTP_LOW_SPEED_TIME = "600"

# Push with progress
git push -u origin main --progress 2>&1 | ForEach-Object { Write-Host $_ }

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Push failed. Retrying with increased buffer..." -ForegroundColor Yellow
    git config http.postBuffer 524288000  # 500MB buffer
    git push -u origin main --progress
}

if ($LASTEXITCODE -ne 0) {
    throw "Failed to push to GitHub. Check your network connection and LFS quota."
}

$receipt.completed_at = (Get-Date).ToUniversalTime().ToString("o")
$receipt.success = $true

Write-Host "[OK] Push complete!" -ForegroundColor Green

# ============================================================
# WRITE RECEIPT
# ============================================================

$receiptPath = Join-Path $WorkDir "upload_receipt_$Timestamp.json"
$receipt | ConvertTo-Json -Depth 10 | Out-File -Encoding UTF8NoBOM $receiptPath

# Also save receipt to user's downloads
$userReceiptPath = Join-Path ([Environment]::GetFolderPath("UserProfile")) "Downloads\os_bundle_upload_receipt_$Timestamp.json"
$receipt | ConvertTo-Json -Depth 10 | Out-File -Encoding UTF8NoBOM $userReceiptPath

# ============================================================
# SUMMARY
# ============================================================

Write-Host ""
Write-Host "=" * 60 -ForegroundColor Green
Write-Host "  UPLOAD COMPLETE" -ForegroundColor Green
Write-Host "=" * 60 -ForegroundColor Green
Write-Host ""
Write-Host "Repository    : $RepoUrl" -ForegroundColor Cyan
Write-Host "Commit        : $CommitSha" -ForegroundColor Cyan
Write-Host "Files         : $fileCount" -ForegroundColor Cyan
Write-Host "Total size    : $(Format-Bytes $totalSize)" -ForegroundColor Cyan
Write-Host "LFS tracked   : $largeFileCount files" -ForegroundColor Cyan
Write-Host ""
Write-Host "Receipt saved : $userReceiptPath" -ForegroundColor Cyan
Write-Host "Working dir   : $WorkDir" -ForegroundColor Gray
Write-Host ""
Write-Host "View online   : $RepoUrl" -ForegroundColor Yellow
Write-Host ""
