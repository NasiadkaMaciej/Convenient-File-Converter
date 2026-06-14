# Convenient File Converter

Convenient File Converter is a simple and quick web tool for converting files between different formats.
It is designed to be intuitive, simple and require minimal input from user.

## Features

- **Multi-format support**: Convert images, audio, and video files.
- **Drag & Drop or File Upload**: Easily upload files by dragging them into the browser or selecting them from the file dialog.
- **Progress Tracking**: Monitor the conversion process through a real-time progress log.
- **Data Security**: Files are stored only temporarily and removed after download to ensure your privacy.
- **Batch Conversion**: Upload and convert multiple files at once (returned together as a ZIP archive).
  
## How does it work?

1. **Select a Category**: Choose from Images, Sound Files, or Videos.
2. **Choose a Format**: Pick the desired output format from the dropdown menu.
3. **Upload Files**: Drag and drop files or click to select them.
4. **Conversion Starts Automatically**: The selected files will begin converting, and the progress will be displayed in the terminal.

| Welcome screen | File upload |
| ------------------------------------------------- | ------------------------------------------------- |
| ![](https://nasiadka.pl/project/file-converter/default.png) | ![](https://nasiadka.pl/project/file-converter/terminal.png) |

## Running

```bash
npm install
npm start            # serves on http://localhost:3000
```

The following environment variables can be used to tune the server: `PORT`, `MAX_FILE_SIZE`, `MAX_FILES`, `MAX_TOTAL_SIZE`, `MAX_CONCURRENT_CONVERSIONS`, `UPLOAD_DIR`, `CONVERTED_DIR`, `RATE_LIMIT_MAX`, `TRUST_PROXY`.

## FAQ

### What formats can I convert to?
- **Images**: PNG, JPG, JPEG, GIF, BMP, TIFF, WebP, AVIF
- **Sound**: MP3, WAV, OGG, FLAC
- **Videos**: MP4, AVI, MKV, MOV, WebM

Additionally, AAC and M4A are accepted as audio input, and FLV as video input - these can be converted *from* but not *to*.

### What is the maximum file size?
- Up to 256MB per file, with a total of 512MB and at most 20 files per upload. Anything larger is rejected.

### How is my data handled?
- Files are stored temporarily on the server only during conversion and deleted automatically once your download completes. Anything left behind by an interrupted conversion is purged within an hour.

### Can I convert multiple files at once?
- Yes! You can upload up to 20 files at once, as long as their total size stays within 512MB. The results are returned together as a ZIP archive.

### How can I help improve the tool?
If you experience some bugs, have suggestions for fixes, features, or improvements, feel free to [contact me](https://nasiadka.pl), open an issue or submit a pull request.
