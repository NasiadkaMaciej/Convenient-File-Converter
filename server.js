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
const port = 3000;

const basePath = __dirname;
// Store files in memory
const uploadDir = "/tmp/uploads/";
const convertedDir = "/tmp/converted/";

const ensureDirectoriesExist = () => {
	if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
	if (!fs.existsSync(convertedDir)) fs.mkdirSync(convertedDir, { recursive: true });
};

ensureDirectoriesExist();

const storage = multer.diskStorage({
	destination: (req, file, cb) => cb(null, uploadDir),
	filename: (req, file, cb) => cb(null, sanitize(file.originalname))
});

const upload = multer({
	storage: storage,
	limits: {
		fileSize: 256 * 1024 * 1024,
	},
	fileFilter: (req, file, cb) => {
		const mimeType = file.mimetype;
		const allowedMimeTypes = [
			"image/png", "image/jpeg", "image/gif", "image/bmp", "image/tiff", "image/webp", "image/svg", "image/heic", "image/heif", "image/avif",
			"audio/mpeg", "audio/wav", "audio/ogg", "audio/flac", "audio/aac", "audio/mp4",
			"video/mp4", "video/x-msvideo", "video/x-matroska", "video/quicktime", "video/x-flv", "video/webm"
		];
		if (!allowedMimeTypes.includes(mimeType))
			return cb(new Error("Invalid file type."));
		cb(null, true);
	}
});

const userEmitters = {};
app.get("/events/:sessionId", (req, res) => {
	const sessionId = req.params.sessionId;
	if (!userEmitters[sessionId]) userEmitters[sessionId] = new EventEmitter();
	const userEmitter = userEmitters[sessionId];

	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache");
	res.setHeader("Connection", "keep-alive");
	res.flushHeaders();

	const heartbeatInterval = setInterval(() => res.write("data: {}\n\n"), 20000);

	userEmitter.on("progress", (message) => {
		console.log(message);
		res.write(`data: ${JSON.stringify({ message })}\n\n`);
	});

	req.on("close", () => {
		clearInterval(heartbeatInterval);
		userEmitter.removeAllListeners("progress");
	});
});

function emitProgressMessage(sessionId, message) {
	const userEmitter = userEmitters[sessionId];
	if (userEmitter) userEmitter.emit("progress", message);
}
const convertFile = async (file, format, category, sessionId) => {
	const originalFileName = path.basename(file.originalname, path.extname(file.originalname));
	const originalFormat = path.extname(file.originalname).slice(1).toLowerCase();
	const outputFileName = `${originalFileName}.${format}`;
	const outputFilePath = path.join(convertedDir, outputFileName);

	emitProgressMessage(sessionId, `Starting conversion for ${file.originalname}...`);

	if (category === "images") {
		emitProgressMessage(sessionId, `Converting ${file.originalname} to ${format}...`);
		const gmFormats = ["bmp", "heif", "heic"]; // Use GM for some formats
		if (gmFormats.includes(originalFormat) || gmFormats.includes(format)) {
			await new Promise((resolve, reject) => {
				gm(file.path)
					.setFormat(format)
					.write(outputFilePath, (err) => {
						if (err) reject(err);
						else resolve();
					});
			});
		} else
			await sharp(file.path).toFormat(format).toFile(outputFilePath);
	} else if (category === "sound" || category === "videos") {
		await new Promise((resolve, reject) => {
			emitProgressMessage(sessionId, `Converting ${file.originalname} to ${format}...`);
			ffmpeg(file.path)
				.output(outputFilePath)
				.format(format)
				.on("end", resolve)
				.on("error", reject)
				.run();
		});
	}
	emitProgressMessage(sessionId, `File ${file.originalname} converted to ${format}.`);
	return { path: outputFilePath, name: outputFileName };
};


app.post("/convert", upload.array("files"), async (req, res) => {
	const { category, format, sessionId } = req.body;
	if (!req.files || req.files.length === 0) return res.status(400).send("No files uploaded.");

	ensureDirectoriesExist();

	let convertedFiles = [];
	let cleanupFiles = [];
	emitProgressMessage(sessionId, "Files uploaded successfully.");

	try {
		const convertPromises = req.files.map((file) =>
			convertFile(file, format, category, sessionId).then((convertedFile) => {
				convertedFiles.push(convertedFile);
				cleanupFiles.push(file.path);
			})
		);
		await Promise.all(convertPromises);

		cleanupFiles.forEach((filePath) => {
			try {
				fs.unlinkSync(filePath);
				emitProgressMessage(sessionId, `Original file deleted after conversion`);
			} catch (err) {
				if (err.code !== "ENOENT")
					console.error("Error deleting original file:", err);
			}
		});

		// Return files
		if (convertedFiles.length === 1) {
			const { path: convertedFilePath, name: originalFileName } = convertedFiles[0];
			emitProgressMessage(sessionId, `Preparing ${originalFileName} for download...`);
			return res.download(convertedFilePath, originalFileName, (err) => {
				if (err) console.error("Error sending file:", err);
				fs.unlinkSync(convertedFilePath);
				emitProgressMessage(sessionId, `Download complete`);
				emitProgressMessage(sessionId, `Converted file ${originalFileName} deleted.`);
			});
		}

		// Zip multiple files
		const zipFileName = "converted_files.zip";
		const zipFilePath = path.join(convertedDir, zipFileName);
		const archive = archiver("zip", { zlib: { level: 9 } });
		const output = fs.createWriteStream(zipFilePath);

		archive.pipe(output);
		for (const { path: filePath, name: originalFileName } of convertedFiles)
			archive.file(filePath, { name: originalFileName });

		await archive.finalize();

		emitProgressMessage(sessionId, `All files added to ZIP archive.`);

		output.on("close", () => {
			emitProgressMessage(sessionId, `ZIP file ready for download.`);
			res.download(zipFilePath, zipFileName, (err) => {
				if (err) console.error("Error sending zip file:", err);
				fs.unlinkSync(zipFilePath);
				convertedFiles.forEach(({ path }) => {
					fs.unlinkSync(path);
					emitProgressMessage(sessionId, `Converted file deleted: ${path}`);
				});
				emitProgressMessage(sessionId, `All files cleaned up after download`);
			});
		});

		output.on("error", (err) => {
			console.error("Error with zip output stream:", err);
			emitProgressMessage(sessionId, `Error creating ZIP file`);
			res.status(500).send("Error creating zip file.");
		});
	} catch (error) {
		console.error("Error during file conversion:", error);
		emitProgressMessage(sessionId, `Error during file conversion`);
		res.status(500).send("Error during file conversion.");
	} finally {
		// Cleanup all files after conversion regardless of success or failure
		cleanupFiles.forEach((filePath) => {
			try {
				fs.unlinkSync(filePath);
				emitProgressMessage(sessionId, `Original file deleted after conversion (final cleanup)`);
			} catch (err) {
				if (err.code !== "ENOENT")
					console.error("Error deleting original file during final cleanup:", err);
			}
		});
	}
});

app.listen(port, () => {
	console.log(`Server running on http://localhost:${port}`);
});
