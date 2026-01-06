const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const archiver = require("archiver");
const sanitize = require("sanitize-filename");
const EventEmitter = require("events");
const crypto = require("crypto");
const gm = require("gm").subClass({ imageMagick: true });

const app = express();
app.set("trust proxy", true);
const port = process.env.PORT || 3000;
// If you want to serve static content via node, uncomment this:
// app.use(express.static('public'));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, "public")));


const UPLOAD_DIR = "/tmp/uploads/";
const CONVERTED_DIR = "/tmp/converted/";
const MAX_FILE_SIZE = 256 * 1024 * 1024; // 256MB
const ALLOWED_MIME_TYPES = {
	images: ["image/png", "image/jpeg", "image/gif", "image/bmp", "image/tiff", "image/webp", "image/svg", "image/heic", "image/heif", "image/avif",],
	sounds: ["audio/mpeg", "audio/wav", "audio/ogg", "audio/flac", "audio/aac", "audio/mp4",],
	videos: ["video/mp4", "video/x-msvideo", "video/x-matroska", "video/quicktime", "video/x-flv", "video/webm",],
};


// Ensure upload and converted directories exist
const ensureDirectoriesExist = () => {
	[UPLOAD_DIR, CONVERTED_DIR].forEach((dir) => {
		try {
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		} catch (err) {
			console.error(`Failed to create directory ${dir}:`, err);
			throw err;
		}
	});
};


// Generate a random file path for storing files
const generateRandomPath = (dir, extension) => {
	const randomString = crypto.randomBytes(8).toString("hex");
	return path.join(dir, `${randomString}.${extension}`);
};


// Create metadata for an uploaded file
const createFileMetadata = (file, uploadDir) => {
	const extension = path.extname(file.originalname).slice(1).toLowerCase();
	const randomizedPath = generateRandomPath(uploadDir, extension);
	return { originalName: file.originalname, randomizedPath, format: extension };
};

ensureDirectoriesExist();

// Multer storage and file filter
const storage = multer.diskStorage({
	destination: (_, __, cb) => cb(null, UPLOAD_DIR),
	filename: (_, file, cb) => cb(null, sanitize(file.originalname)),
});

const upload = multer({
	storage,
	limits: { fileSize: MAX_FILE_SIZE },
	fileFilter: (_, file, cb) => {
		const mimeType = file.mimetype;
		const isAllowed = Object.values(ALLOWED_MIME_TYPES).flat().includes(mimeType);
		cb(isAllowed ? null : new Error("Unsupported file type."), isAllowed);
	},
});

// Session and progress management
const sessions = new Map(); // userIP -> { activeSessions: Map(sessionId -> { files: [] }) }
const userEmitters = new Map(); // sessionId -> EventEmitter

const createSession = (userIP, sessionId) => {
	let userSessions = sessions.get(userIP)?.activeSessions;
	if (!userSessions) {
		userSessions = new Map();
		sessions.set(userIP, { activeSessions: userSessions });
	}
	if (!userSessions.has(sessionId)) userSessions.set(sessionId, { files: [] });
	return userSessions.get(sessionId);
};

const emitProgressMessage = (sessionId, message) => {
	const emitter = userEmitters.get(sessionId);
	if (emitter) emitter.emit("progress", message);
	if (process.env.NODE_ENV !== "test") {
		console.log(`[Session ${sessionId}]: ${message}`);
	}
};

// Server-Sent Events endpoint for progress updates
app.get("/events/:sessionId", (req, res) => {
	const { sessionId } = req.params;
	if (!userEmitters.has(sessionId)) userEmitters.set(sessionId, new EventEmitter());
	const emitter = userEmitters.get(sessionId);

	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache");
	res.setHeader("Connection", "keep-alive");
	res.flushHeaders();

	const heartbeatInterval = setInterval(() => res.write(": keep-alive\n\n"), 15000);

	const progressListener = (message) => {
		res.write(`data: ${JSON.stringify({ message })}\n\n`);
	};
	emitter.on("progress", progressListener);

	req.on("close", () => {
		clearInterval(heartbeatInterval);
		emitter.removeListener("progress", progressListener);
		userEmitters.delete(sessionId);
	});
});

// Convert a single file to the requested format
const convertFile = async (sessionId, fileMetadata, format, category) => {
	const { originalName, randomizedPath } = fileMetadata;
	ensureDirectoriesExist();
	const outputPath = generateRandomPath(CONVERTED_DIR, format);

	emitProgressMessage(
		sessionId,
		`Converted file "${path.basename(originalName, path.extname(originalName))}.${format}" is temporarily stored as "${outputPath}".`
	);
	try {
		emitProgressMessage(sessionId, `Converting "${originalName}" to ${format}...`);
		if (category === "images") {
			const gmFormats = ["bmp", "heif", "heic"];
			if (gmFormats.includes(fileMetadata.format) || gmFormats.includes(format)) {
				await new Promise((resolve, reject) => {
					gm(randomizedPath)
						.setFormat(format)
						.write(outputPath, (err) => (err ? reject(err) : resolve()));
				});
			} else {
				await sharp(randomizedPath).toFormat(format).toFile(outputPath);
			}
		} else if (["sounds", "videos"].includes(category)) {
			await new Promise((resolve, reject) => {
				ffmpeg(randomizedPath)
					.output(outputPath)
					.format(format)
					//.outputOptions(['-c:v h264_nvenc']) -> Uncomment to enable NVIDIA GPU acceleration if available
					.on("end", resolve)
					.on("error", reject)
					.run();
			});
		} else {
			throw new Error("Invalid category");
		}

		emitProgressMessage(sessionId, `File "${originalName}" converted to ${format}.`);
		return { originalName, randomizedPath: outputPath, format };
	} catch (error) {
		emitProgressMessage(sessionId, `Error converting file: ${error.message}`);
		throw new Error(`Failed to convert "${originalName}": ${error.message}`);
	}
};


// File conversion endpoint
app.post("/convert", upload.array("files"), async (req, res) => {
	const { category, format, sessionId } = req.body;
	const userIP = req.ip;
	const msg = (message) => emitProgressMessage(sessionId, message);

	// Input validation
	if (!req.files?.length) return res.status(400).send("No files uploaded.");
	if (!["images", "sounds", "videos"].includes(category))
		return res.status(400).send("Invalid category.");
	if (!format || typeof format !== "string" || !/^[a-zA-Z0-9]+$/.test(format))
		return res.status(400).send("No format specified or invalid format.");
	if (!sessionId || typeof sessionId !== "string" || sessionId.length < 3)
		return res.status(400).send("Invalid session ID.");

	ensureDirectoriesExist();
	const sessionData = createSession(userIP, sessionId);
	msg("Files uploaded successfully.");

	try {
		msg("Processing files...");
		req.files.forEach((file) => {
			ensureDirectoriesExist();
			const fileMetadata = createFileMetadata(file, UPLOAD_DIR);
			try {
				fs.renameSync(file.path, fileMetadata.randomizedPath);
			} catch (err) {
				msg(`Error moving file: ${err.message}`);
				throw err;
			}
			msg(`File "${fileMetadata.originalName}" is temporarily stored as "${fileMetadata.randomizedPath}".`);
			sessionData.files.push(fileMetadata);
		});

		// Convert all files
		const convertedFiles = await Promise.all(
			sessionData.files.map((file) => convertFile(sessionId, file, format, category))
		);

		let downloadPath, downloadName;
		if (convertedFiles.length === 1) {
			const file = convertedFiles[0];
			const originalBaseName = path.basename(file.originalName, path.extname(file.originalName));
			downloadPath = file.randomizedPath;
			downloadName = `${originalBaseName}.${format}`;
		} else {
			// Create a zip archive for multiple files
			const zipFileName = `converted_${crypto.randomBytes(8).toString("hex")}.zip`;
			const zipPath = path.join(CONVERTED_DIR, zipFileName);
			const archive = archiver("zip", { zlib: { level: 9 } });
			const output = fs.createWriteStream(zipPath);

			archive.pipe(output);
			convertedFiles.forEach((file) => {
				const originalBaseName = path.basename(file.originalName, path.extname(file.originalName));
				const archiveName = `${originalBaseName}.${format}`;
				archive.file(file.randomizedPath, { name: archiveName });
			});
			await new Promise((resolve, reject) => {
				output.on("close", resolve);
				archive.on("error", reject);
				archive.finalize();
			});

			msg(`Created archive "${zipPath}".`);
			downloadPath = zipPath;
			downloadName = zipFileName;
		}

		msg("Conversion completed. Preparing for download.");
		res.download(downloadPath, downloadName, (err) => {
			if (err) {
				msg(`Error while sending file for download: ${err.message}`);
				return res.status(500).send(`Error while sending file for download: ${err.message}`);
			}

			msg(`File "${downloadName}" sent for download.`);

			// Cleanup
			const safeUnlink = (filePath, label) => {
				try {
					if (fs.existsSync(filePath)) {
						fs.unlinkSync(filePath);
						msg('Removed ' + label + ': ' + filePath);
					}
				} catch (e) {
					msg('Failed to remove ' + label + ': ' + filePath + ' (' + e.message + ')');
				}
			};
			sessionData.files.forEach(({ randomizedPath }) => safeUnlink(randomizedPath, "original file"));
			convertedFiles.forEach(({ randomizedPath }) => safeUnlink(randomizedPath, "converted file"));
			if (convertedFiles.length > 1) safeUnlink(downloadPath, "archive file");

			// Remove session
			const userSessions = sessions.get(userIP)?.activeSessions;
			if (userSessions) userSessions.delete(sessionId);
			msg("Cleanup complete.");
			userEmitters.delete(sessionId);
		});

	} catch (error) {
		msg('Error: ' + error.message);
		if (error.stack) msg(error.stack);
		return res.status(500).send("An error occurred during file conversion.");
	}
});


// Start the server
app.listen(port, () => {
	console.log('Server running on http://localhost:' + port);
});
