const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const { ZipArchive } = require("archiver");
const sanitize = require("sanitize-filename");
const EventEmitter = require("events");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const gm = require("gm").subClass({ imageMagick: true });
const { CATEGORY_FORMATS, ALLOWED_MIME_TYPES, ALLOWED_INPUT_EXTENSIONS, CATEGORIES } = require("./formats");

// file-type is ESM-only; load it lazily via dynamic import from this CommonJS module.
let fileTypeFromFilePromise = null;
const getFileTypeFromFile = async () => {
	if (!fileTypeFromFilePromise) fileTypeFromFilePromise = import("file-type").then((m) => m.fileTypeFromFile);
	return fileTypeFromFilePromise;
};

const app = express();
// Number of reverse-proxy hops to trust for client IP (X-Forwarded-For).
// A specific value (not `true`) is required so rate limiting can't be bypassed.
app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1));

// Configuration (overridable via environment variables)
const port = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(os.tmpdir(), "cfc-uploads");
const CONVERTED_DIR = process.env.CONVERTED_DIR || path.join(os.tmpdir(), "cfc-converted");
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE) || 256 * 1024 * 1024; // 256MB per file
const MAX_FILES = Number(process.env.MAX_FILES) || 20; // files per request
const MAX_TOTAL_SIZE = Number(process.env.MAX_TOTAL_SIZE) || 512 * 1024 * 1024; // total per request
const MAX_CONCURRENT_CONVERSIONS = Number(process.env.MAX_CONCURRENT_CONVERSIONS) || 3;
const FILE_TTL_MS = Number(process.env.FILE_TTL_MS) || 60 * 60 * 1000; // sweep files older than 1h
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS) || 15 * 60 * 1000;

// Serve static files from public directory
app.use(express.static(path.join(__dirname, "public")));

// Ensure upload and converted directories exist (run once at startup)
const ensureDirectoriesExist = async () => {
	await Promise.all(
		[UPLOAD_DIR, CONVERTED_DIR].map((dir) =>
			fsp.mkdir(dir, { recursive: true }).catch((err) => {
				console.error(`Failed to create directory ${dir}:`, err);
				throw err;
			})
		)
	);
};

// Generate a random file path for storing files
const generateRandomPath = (dir, extension) => {
	const randomString = crypto.randomBytes(8).toString("hex");
	return path.join(dir, extension ? `${randomString}.${extension}` : randomString);
};

// Server-side log including sensitive details (paths); never sent to clients.
const logServer = (sessionId, message) => {
	if (process.env.NODE_ENV !== "test") console.log(`[Session ${sessionId}]: ${message}`);
};

// Multer storage: write directly to a randomized name to avoid filename
// collisions between concurrent uploads (no rename step needed).
const storage = multer.diskStorage({
	destination: (_, __, cb) => cb(null, UPLOAD_DIR),
	filename: (_, file, cb) => {
		const extension = path.extname(file.originalname).slice(1).toLowerCase();
		cb(null, path.basename(generateRandomPath("", sanitize(extension) || "bin")));
	},
});

const upload = multer({
	storage,
	limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
	fileFilter: (_, file, cb) => {
		const isAllowed = Object.values(ALLOWED_MIME_TYPES).flat().includes(file.mimetype);
		cb(isAllowed ? null : new Error("Unsupported file type."), isAllowed);
	},
});

// Detect the real input format from file content (not the filename, which may
// be wrong or spoofed). Returns the canonical extension if the content is a
// supported input for the category, otherwise null. Used both to reject invalid
// uploads and to pick the right converter (gm vs sharp).
const detectInputExtension = async (filePath, category) => {
	const fileTypeFromFile = await getFileTypeFromFile();
	const detected = await fileTypeFromFile(filePath);
	if (detected && ALLOWED_INPUT_EXTENSIONS[category].includes(detected.ext)) return detected.ext;
	return null;
};

// Session and progress management
const sessions = new Map(); // userIP -> { activeSessions: Map(sessionId -> { files: [], outputs: [] }) }
const userEmitters = new Map(); // sessionId -> EventEmitter

const createSession = (userIP, sessionId) => {
	let userSessions = sessions.get(userIP)?.activeSessions;
	if (!userSessions) {
		userSessions = new Map();
		sessions.set(userIP, { activeSessions: userSessions });
	}
	if (!userSessions.has(sessionId)) userSessions.set(sessionId, { files: [], outputs: [] });
	return userSessions.get(sessionId);
};

// Emit a user-facing progress message (never includes filesystem paths).
const emitProgressMessage = (sessionId, message) => {
	const emitter = userEmitters.get(sessionId);
	if (emitter) emitter.emit("progress", message);
	logServer(sessionId, message);
};

// Remove all files belonging to a session and forget the session/emitter.
const cleanupSession = async (userIP, sessionId, sessionData, extraPaths = []) => {
	const paths = [
		...sessionData.files.map((f) => f.randomizedPath),
		...sessionData.outputs,
		...extraPaths,
	];
	await Promise.all(
		paths.map((filePath) =>
			fsp.rm(filePath, { force: true }).catch((e) => logServer(sessionId, `Failed to remove ${filePath}: ${e.message}`))
		)
	);
	// Emit before forgetting the emitter below, otherwise the message is lost.
	emitProgressMessage(sessionId, "Temporary files cleaned up.");
	const userSessions = sessions.get(userIP)?.activeSessions;
	if (userSessions) {
		userSessions.delete(sessionId);
		if (userSessions.size === 0) sessions.delete(userIP);
	}
	userEmitters.delete(sessionId);
};

// Run an async mapper over items with bounded concurrency.
const mapWithConcurrency = async (items, limit, fn) => {
	const results = new Array(items.length);
	let cursor = 0;
	const worker = async () => {
		while (cursor < items.length) {
			const index = cursor++;
			results[index] = await fn(items[index], index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
};

// Periodically remove orphaned files (left behind by crashes or disconnects).
const sweepOldFiles = async () => {
	const cutoff = Date.now() - FILE_TTL_MS;
	for (const dir of [UPLOAD_DIR, CONVERTED_DIR]) {
		let entries;
		try {
			entries = await fsp.readdir(dir);
		} catch {
			continue;
		}
		await Promise.all(
			entries.map(async (entry) => {
				const filePath = path.join(dir, entry);
				try {
					const stat = await fsp.stat(filePath);
					if (stat.isFile() && stat.mtimeMs < cutoff) await fsp.rm(filePath, { force: true });
				} catch {
					/* ignore */
				}
			})
		);
	}
};

// Expose the supported formats/limits so the client stays in sync with the server.
app.get("/api/config", (_, res) => {
	res.json({
		categoryFormats: CATEGORY_FORMATS,
		allowedMimeTypes: ALLOWED_MIME_TYPES,
		limits: { maxFileSize: MAX_FILE_SIZE, maxFiles: MAX_FILES, maxTotalSize: MAX_TOTAL_SIZE },
	});
});

// Server-Sent Events endpoint for progress updates
app.get("/events/:sessionId", (req, res) => {
	const { sessionId } = req.params;
	if (!userEmitters.has(sessionId)) userEmitters.set(sessionId, new EventEmitter());
	const emitter = userEmitters.get(sessionId);

	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache");
	res.setHeader("Connection", "keep-alive");
	res.setHeader("X-Accel-Buffering", "no");
	res.flushHeaders();

	const heartbeatInterval = setInterval(() => res.write(": keep-alive\n\n"), 15000);

	const progressListener = (message) => {
		res.write(`data: ${JSON.stringify({ message })}\n\n`);
	};
	emitter.on("progress", progressListener);

	req.on("close", () => {
		clearInterval(heartbeatInterval);
		emitter.removeListener("progress", progressListener);
		// Only forget the emitter if nothing else is listening (a conversion may still be running).
		if (emitter.listenerCount("progress") === 0) userEmitters.delete(sessionId);
	});
});

// Convert a single file to the requested format
const convertFile = async (sessionId, fileMetadata, format, category) => {
	const { originalName, randomizedPath } = fileMetadata;
	const outputPath = generateRandomPath(CONVERTED_DIR, format);
	const displayName = `${path.basename(originalName, path.extname(originalName))}.${format}`;

	try {
		emitProgressMessage(sessionId, `Converting "${originalName}" to ${format}...`);
		if (category === "images") {
			// sharp (libvips) cannot read or write BMP, so route BMP in/out through
			// ImageMagick (gm). Everything else uses sharp.
			const gmFormats = ["bmp"];
			if (gmFormats.includes(fileMetadata.format) || gmFormats.includes(format)) {
				await new Promise((resolve, reject) => {
					gm(randomizedPath)
						.setFormat(format)
						.write(outputPath, (err) => (err ? reject(err) : resolve()));
				});
			} else {
				await sharp(randomizedPath).toFormat(format).toFile(outputPath);
			}
		} else if (category === "sounds" || category === "videos") {
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
		return { originalName, randomizedPath: outputPath, format, displayName };
	} catch (error) {
		// Remove any partial output the converter may have written before failing.
		await fsp.rm(outputPath, { force: true }).catch(() => {});
		emitProgressMessage(sessionId, `Error converting "${originalName}": ${error.message}`);
		throw new Error(`Failed to convert "${originalName}": ${error.message}`);
	}
};

// Build a zip archive from the converted files and return its path.
const createArchive = async (convertedFiles) => {
	const zipFileName = `converted_${crypto.randomBytes(8).toString("hex")}.zip`;
	const zipPath = path.join(CONVERTED_DIR, zipFileName);
	const archive = new ZipArchive({ zlib: { level: 9 } });
	const output = fs.createWriteStream(zipPath);

	archive.pipe(output);
	convertedFiles.forEach((file) => archive.file(file.randomizedPath, { name: file.displayName }));
	await new Promise((resolve, reject) => {
		output.on("close", resolve);
		archive.on("error", reject);
		archive.finalize();
	});
	return { zipPath, zipFileName };
};

// Rate limiter for the conversion endpoint (CPU-intensive work).
const convertLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	max: Number(process.env.RATE_LIMIT_MAX) || 30,
	standardHeaders: true,
	legacyHeaders: false,
	message: "Too many conversion requests. Please try again later.",
});

// File conversion endpoint
app.post("/convert", convertLimiter, upload.array("files"), async (req, res) => {
	const { category, format, sessionId } = req.body;
	const userIP = req.ip;
	const uploadedPaths = (req.files || []).map((f) => f.path);

	// Helper to remove just-uploaded files when we reject before creating a session.
	const discardUploads = () =>
		Promise.all(uploadedPaths.map((p) => fsp.rm(p, { force: true }).catch(() => {})));

	// Input validation
	if (!req.files?.length) return res.status(400).send("No files uploaded.");
	if (!CATEGORIES.includes(category)) {
		await discardUploads();
		return res.status(400).send("Invalid category.");
	}
	if (!format || typeof format !== "string" || !CATEGORY_FORMATS[category].includes(format.toLowerCase())) {
		await discardUploads();
		return res.status(400).send("No format specified or invalid format.");
	}
	if (!sessionId || typeof sessionId !== "string" || sessionId.length < 3 || sessionId.length > 100) {
		await discardUploads();
		return res.status(400).send("Invalid session ID.");
	}
	const totalSize = req.files.reduce((sum, f) => sum + f.size, 0);
	if (totalSize > MAX_TOTAL_SIZE) {
		await discardUploads();
		return res.status(400).send("Total upload size exceeds the allowed limit.");
	}

	// Verify actual file contents match the chosen category, and capture the
	// real input format (used for converter routing).
	const detectedExtensions = [];
	for (const file of req.files) {
		let ext = null;
		try {
			ext = await detectInputExtension(file.path, category);
		} catch {
			ext = null;
		}
		if (!ext) {
			await discardUploads();
			return res.status(400).send(`"${file.originalname}" does not appear to be a valid ${category.slice(0, -1)} file.`);
		}
		detectedExtensions.push(ext);
	}

	const sessionData = createSession(userIP, sessionId);
	const msg = (message) => emitProgressMessage(sessionId, message);

	sessionData.files = req.files.map((file, i) => ({
		originalName: file.originalname,
		randomizedPath: file.path,
		format: detectedExtensions[i],
	}));

	try {
		msg(`Files uploaded successfully (${sessionData.files.length}).`);
		sessionData.files.forEach((file) => msg(`Received "${file.originalName}" (${file.format}).`));
		msg("Processing files...");

		const normalizedFormat = format.toLowerCase();
		const convertedFiles = await mapWithConcurrency(
			sessionData.files,
			MAX_CONCURRENT_CONVERSIONS,
			async (file) => {
				const result = await convertFile(sessionId, file, normalizedFormat, category);
				sessionData.outputs.push(result.randomizedPath);
				return result;
			}
		);

		let downloadPath, downloadName;
		if (convertedFiles.length === 1) {
			downloadPath = convertedFiles[0].randomizedPath;
			downloadName = convertedFiles[0].displayName;
		} else {
			msg(`Packaging ${convertedFiles.length} files into an archive...`);
			const { zipPath, zipFileName } = await createArchive(convertedFiles);
			sessionData.outputs.push(zipPath);
			msg("Archive created.");
			downloadPath = zipPath;
			downloadName = zipFileName;
		}

		msg("Conversion completed. Preparing for download.");
		res.download(downloadPath, downloadName, async (err) => {
			if (err) msg(`Error while sending file for download: ${err.message}`);
			else msg(`File "${downloadName}" sent for download.`);
			await cleanupSession(userIP, sessionId, sessionData);
		});
	} catch (error) {
		msg(`Error: ${error.message}`);
		logServer(sessionId, error.stack || error.message);
		await cleanupSession(userIP, sessionId, sessionData);
		if (!res.headersSent) res.status(500).send("An error occurred during file conversion.");
	}
});

// Centralized error handling (e.g. Multer limits / unsupported file type).
app.use((err, _req, res, _next) => {
	if (res.headersSent) return;
	if (err instanceof multer.MulterError) {
		const messages = {
			LIMIT_FILE_SIZE: `A file exceeds the maximum size of ${Math.round(MAX_FILE_SIZE / (1024 * 1024))}MB.`,
			LIMIT_FILE_COUNT: `Too many files. The maximum is ${MAX_FILES} per request.`,
		};
		return res.status(400).send(messages[err.code] || "Upload error.");
	}
	if (err?.message === "Unsupported file type.") return res.status(400).send(err.message);
	console.error("Unhandled error:", err);
	res.status(500).send("Internal server error.");
});

// Start the server
const start = async () => {
	await ensureDirectoriesExist();
	setInterval(sweepOldFiles, SWEEP_INTERVAL_MS).unref();
	sweepOldFiles();
	app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
};

if (require.main === module) start();

module.exports = { app, start };
