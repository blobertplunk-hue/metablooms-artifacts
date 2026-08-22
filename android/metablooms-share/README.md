# MetaBlooms Android Share

A minimal native Android share target for MetaBlooms.

## What it does
- Appears in Android Share for text/URLs, images, audio/video, PDFs, Office/general application files.
- Lets the user review/edit text and add context before sending.
- Sends text to the existing `metablooms-mobile?api=capture` endpoint.
- Uploads shared files (25 MB max each) to `metablooms-mobile?api=upload`.
- Supports one-time pairing through `metablooms://pair?token=...` or manual pairing-code paste.

Current Android guidance recommends declaring `ACTION_SEND`/`ACTION_SEND_MULTIPLE` intent filters and giving users a chance to confirm/edit shared content before processing it.
