// Single source of truth for supported formats, shared by the server and,
// via GET /api/config, by the browser client.

// Output formats offered in the UI dropdown for each category.
const CATEGORY_FORMATS = {
	images: ["png", "jpg", "jpeg", "gif", "bmp", "tiff", "webp", "avif"],
	sounds: ["mp3", "wav", "ogg", "flac"],
	videos: ["mp4", "avi", "mkv", "mov", "webm"],
};

// MIME types accepted by the upload filter (based on the browser-reported type).
const ALLOWED_MIME_TYPES = {
	images: ["image/png", "image/jpeg", "image/gif", "image/bmp", "image/tiff", "image/webp", "image/avif"],
	sounds: ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/ogg", "audio/flac", "audio/x-flac", "audio/aac", "audio/mp4"],
	videos: ["video/mp4", "video/x-msvideo", "video/x-matroska", "video/quicktime", "video/x-flv", "video/webm"],
};

// Real file extensions (as reported by content sniffing) accepted as input for
// each category. Used to verify that the actual bytes match the chosen category,
// independent of the client-supplied MIME type.
const ALLOWED_INPUT_EXTENSIONS = {
	images: ["png", "jpg", "gif", "bmp", "tif", "webp", "avif"],
	sounds: ["mp3", "wav", "ogg", "oga", "opus", "flac", "m4a", "aac", "mp4"],
	videos: ["mp4", "m4v", "avi", "mkv", "mka", "mov", "flv", "webm"],
};

const CATEGORIES = Object.keys(CATEGORY_FORMATS);

module.exports = { CATEGORY_FORMATS, ALLOWED_MIME_TYPES, ALLOWED_INPUT_EXTENSIONS, CATEGORIES };
