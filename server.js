const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const archiver = require("archiver");
const sanitize = require("sanitize-filename");
const EventEmitter = require("events");
const gm = require("gm").subClass({ imageMagick: true });

const app = express();
app.set('trust proxy', true);
// If you want to serve static content via node, uncomment this:
// app.use(express.static('public'));
const port = 3000;

const uploadDir = "/tmp/uploads/";
const convertedDir = "/tmp/converted/";

const MAX_FILE_SIZE_MB = 256;
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;

const allowedMimeTypes = {
	images: [
		"image/png", "image/jpeg", "image/gif", "image/bmp", "image/tiff",
		"image/webp", "image/svg", "image/heic", "image/heif", "image/avif",
	],
	sounds: [
		"audio/mpeg", "audio/wav", "audio/ogg", "audio/flac",
		"audio/aac", "audio/mp4",
	],
	videos: [
		"video/mp4", "video/x-msvideo", "video/x-matroska",
		"video/quicktime", "video/x-flv", "video/webm",
	],
};

const ensureDirectoriesExist = () => {
	[uploadDir, convertedDir].forEach(dir => {
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	});
};
ensureDirectoriesExist();

const storage = multer.diskStorage({
	destination: (_, __, cb) => cb(null, uploadDir),
	filename: (_, file, cb) => cb(null, sanitize(file.originalname)),
});

const upload = multer({
	storage,
	limits: { fileSize: MAX_FILE_SIZE },
	fileFilter: (_, file, cb) => {
		const mimeType = file.mimetype;
		const isAllowed = Object.values(allowedMimeTypes).flat().includes(mimeType);
		cb(isAllowed ? null : new Error("Unsupported file type."), isAllowed);
	},
});

const userEmitters = new Map();

const emitProgressMessage = (sessionId, message) => {
	const emitter = userEmitters.get(sessionId);
	if (emitter) emitter.emit("progress", message);
	console.log(`[Session ${sessionId}]: ${message}`);
};

app.get("/events/:sessionId", (req, res) => {
	const { sessionId } = req.params;
	if (!userEmitters.has(sessionId)) userEmitters.set(sessionId, new EventEmitter());
	const emitter = userEmitters.get(sessionId);

	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache");
	res.setHeader("Connection", "keep-alive");
	res.flushHeaders();

	const heartbeatInterval = setInterval(() => res.write(": keep-alive\n\n"), 15000);

	emitter.on("progress", (message) => {
		res.write(`data: ${JSON.stringify({ message })}\n\n`);
	});

	req.on("close", () => {
		clearInterval(heartbeatInterval);
		emitter.removeAllListeners("progress");
		userEmitters.delete(sessionId);
	});
});

const convertFile = async (file, format, category, sessionId) => {
	const originalFormat = path.extname(file.originalname).slice(1).toLowerCase();
	const outputFilePath = path.join(convertedDir, `${path.basename(file.originalname, path.extname(file.originalname))}.${format}`);

	try {
		if (category === "images") {
			const gmFormats = ["bmp", "heif", "heic"]; // Use GM for some formats
			if (gmFormats.includes(originalFormat) || gmFormats.includes(format)) {
				await new Promise((resolve, reject) => {
					gm(file.path).setFormat(format).write(outputFilePath, (err) => {
						if (err) reject(err);
						else resolve();
					});
				});
			} else
				await sharp(file.path).toFormat(format).toFile(outputFilePath);
		} else if (["sounds", "videos"].includes(category)) {
			await new Promise((resolve, reject) => {
				emitProgressMessage(sessionId, `Converting "${file.originalname}" to ${format}...`);
				ffmpeg(file.path)
					.output(outputFilePath)
					.format(format)
					.on("end", resolve)
					.on("error", reject)
					.run();
			});
		}
		else
			throw new Error("Invalid category");

		emitProgressMessage(sessionId, `File converted "${file.originalname}" to ${format}.`);
		return { path: outputFilePath, name: path.basename(outputFilePath) };

	} catch (error) {
		throw new Error(`Failed to convert "${file.originalname}": ${error.message}`);
	}
};

app.post("/convert", upload.array("files"), async (req, res) => {
	const { category, format, sessionId } = req.body;

	if (!req.files?.length) return res.status(400).send("No files uploaded.");
	if (!["images", "sounds", "videos"].includes(category)) return res.status(400).send("Invalid category.");
	if (!format) return res.status(400).send("No format specified.");

	ensureDirectoriesExist();

	const cleanupPaths = [];
	let convertedFiles = [];

	emitProgressMessage(sessionId, "Files uploaded successfully.");

	try {
		convertedFiles = await Promise.all(
			req.files.map(async (file) => {
				cleanupPaths.push({ path: file.path, name: file.filename });
				return convertFile(file, format, category, sessionId);
			})
		);

		let downloadPath, downloadName;
		if (convertedFiles.length === 1) {
			const file = convertedFiles[0];
			downloadPath = file.path;
			downloadName = file.name;
		} else {
			const zipPath = path.join(convertedDir, "converted_files.zip");
			const archive = archiver("zip", { zlib: { level: 9 } });
			const output = fs.createWriteStream(zipPath);

			archive.pipe(output);
			convertedFiles.forEach(file => archive.file(file.path, { name: file.name }));
			await archive.finalize();

			emitProgressMessage(sessionId, `Created archive "${zipPath}".`);
			downloadPath = zipPath;
			downloadName = "converted_files.zip";
			convertedFiles.push({ path: zipPath, name: downloadName })
		}

		emitProgressMessage(sessionId, "Conversion completed. Preparing for download.");
		res.download(downloadPath, downloadName, (err) => {
			if (err) {
				emitProgressMessage(sessionId, `Error while sending file for download: ${err.message}`);
				return res.status(500).send(`Error while sending file for download: ${err.message}`);
			}
			else
				emitProgressMessage(sessionId, `File "${downloadName}" sent for download.`);

			if (fs.existsSync(downloadPath)) fs.unlinkSync(downloadPath);
			emitProgressMessage(sessionId, `Removed converted file: "${downloadName}"`);

			cleanupPaths.forEach((file) => {
				if (fs.existsSync(file.path)) {
					fs.unlinkSync(file.path);
					emitProgressMessage(sessionId, `Removed original file: "${file.name}"`);
				}
			});

			convertedFiles.forEach((file) => {
				if (fs.existsSync(file.path)) {
					fs.unlinkSync(file.path);
					emitProgressMessage(sessionId, `Removed converted file: "${file.name}"`);
				}
			});

			emitProgressMessage(sessionId, "Cleanup complete.");
			userEmitters.delete(sessionId);
		});
	}
	catch (error) {
		emitProgressMessage(sessionId, `Error: ${error.message}`);
		return res.status(500).send("An error occurred during file conversion.");
	}
})

app.listen(port, () => {
	console.log(`Server running on http://localhost:${port}`);
});
