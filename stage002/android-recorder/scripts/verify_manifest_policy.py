#!/usr/bin/env python3
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "app/src/main/AndroidManifest.xml"
ANDROID = "{http://schemas.android.com/apk/res/android}"
REQUIRED = {
    "android.permission.RECORD_AUDIO",
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_MICROPHONE",
}

def fail(message: str) -> int:
    print(f"FAIL: {message}")
    return 1

def main() -> int:
    if not MANIFEST.is_file():
        return fail(f"missing {MANIFEST.relative_to(ROOT)}")
    text = MANIFEST.read_text(encoding="utf-8")
    if "android.permission.INTERNET" in text:
        return fail("INTERNET permission is forbidden")
    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        return fail(f"invalid XML: {exc}")
    permissions = {node.attrib.get(ANDROID + "name") for node in root.findall("uses-permission")}
    missing = sorted(REQUIRED - permissions)
    if missing:
        return fail("missing permissions: " + ", ".join(missing))
    services = root.findall("./application/service")
    microphone_services = [service for service in services if service.attrib.get(ANDROID + "foregroundServiceType") == "microphone" and service.attrib.get(ANDROID + "exported") == "false"]
    if not microphone_services:
        return fail('missing non-exported service with foregroundServiceType="microphone"')
    print("PASS: manifest microphone/privacy policy")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
