const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const archiver = require('archiver');
const sanitize = require('sanitize-filename');
const EventEmitter = require('events');

const app = express();
const port = 3000;

const basePath = __dirname;  // Use __dirname for absolute paths

// Store files in memory
const uploadDir = '/tmp/uploads/';
const convertedDir = '/tmp/converted/';

const ensureDirectoriesExist = () => {
	if (!fs.existsSync(uploadDir))
		fs.mkdirSync(uploadDir, { recursive: true });
	if (!fs.existsSync(convertedDir))
		fs.mkdirSync(convertedDir, { recursive: true });
};

ensureDirectoriesExist();

const storage = multer.diskStorage({
	destination: (req, file, cb) => {
		cb(null, uploadDir);
	},
	filename: (req, file, cb) => {
		cb(null, sanitize(file.originalname));
	}
});

const upload = multer({
	storage: storage,
	limits: {
		fileSize: 512 * 1024 * 1024, // 512M, amount of files does not matter
	},
	fileFilter: (req, file, cb) => {
		const mimeType = file.mimetype;
		const allowedMimeTypes = [
			"image/png", "image/jpeg", "image/jpeg", "image/gif", "image/bmp", "image/tiff", "image/webp", "image/svg+xml", 
			"audio/mpeg", "audio/wav", "audio/ogg", "audio/flac", "audio/aac", "audio/mp4", 
			"video/mp4", "video/x-msvideo", "video/x-matroska", "video/quicktime", "video/x-flv", "video/webm"
		];
		if (!allowedMimeTypes.includes(mimeType)) {
			return cb(new Error('Invalid file type.'));
		}
		cb(null, true);
	}
});

// Event emitter to handle progress messages
const progressEmitter = new EventEmitter();
app.use(express.static(path.join(basePath, 'public')));

// SSE route to send progress updates to the client
app.get('/events', (req, res) => {
	res.setHeader('Content-Type', 'text/event-stream');
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Connection', 'keep-alive');
	res.flushHeaders();

	// Heartbeat to keep connection alive
	const heartbeatInterval = setInterval(() => {
		res.write('data: {}\n\n');
	}, 10000);

	progressEmitter.on('progress', (message) => {
		console.log(`Server log: ${message}`);
		res.write(`data: ${JSON.stringify({ message })}\n\n`);
	});

	req.on('close', () => {
		clearInterval(heartbeatInterval); // Clean up heartbeat on connection close
		progressEmitter.removeAllListeners('progress');
	});
});

app.post('/convert', upload.array('files'), async (req, res) => {
	const { category, format } = req.body;

	if (!req.files || req.files.length === 0) {
		return res.status(400).send('No files uploaded.');
	}

	ensureDirectoriesExist();

	let convertedFiles = [];
	let cleanupFiles = [];

	progressEmitter.emit('progress', 'Files uploaded successfully.');

	try {
		// Start conversion
		for (const file of req.files) {
			const originalFileName = path.basename(file.originalname, path.extname(file.originalname));
			const outputFileName = `${originalFileName}.${format}`;
			const outputFilePath = path.join(convertedDir, outputFileName);
			convertedFiles.push({ path: outputFilePath, name: outputFileName });
			cleanupFiles.push(file.path);  // Track original files for cleanup

			progressEmitter.emit('progress', `Starting conversion for ${file.originalname}...`);

			// Convert based on category
			if (category === 'images') {
				await sharp(file.path).toFormat(format).toFile(outputFilePath);
				progressEmitter.emit('progress', `Image ${file.originalname} converted to ${format}.`);
			} else if (category === 'sound' || category === 'videos') {
				await new Promise((resolve, reject) => {
					progressEmitter.emit('progress', `Converting ${file.originalname} to ${format}...`);
					ffmpeg(file.path)
						.output(outputFilePath)
						.format(format)
						.on('end', resolve)
						.on('error', reject)
						.run();
				});
				progressEmitter.emit('progress', `File ${file.originalname} converted to ${format}.`);
			}
		}

		// Remove uploaded files after conversion
		cleanupFiles.forEach((filePath) => {
			try {
				fs.unlinkSync(filePath);
				progressEmitter.emit('progress', `Original file deleted after conversion.`);
				
			} catch (err) {
				console.error('Error deleting original file:', err);
			}
		});

		// Return files
		if (convertedFiles.length === 1) {
			const { path: convertedFilePath, name: originalFileName } = convertedFiles[0];
			progressEmitter.emit('progress', `Preparing ${originalFileName} for download.`);
			return res.download(convertedFilePath, originalFileName, (err) => {
				if (err) console.error('Error sending file:', err);
				fs.unlinkSync(convertedFilePath); // Delete converted file after download
				progressEmitter.emit('progress', `Download complete. Converted file ${originalFileName} deleted.`);
			});
		}

		// Zip multiple files
		const zipFileName = 'converted_files.zip';
		const zipFilePath = path.join(convertedDir, zipFileName);
		const archive = archiver('zip', { zlib: { level: 9 } });
		const output = fs.createWriteStream(zipFilePath);

		archive.pipe(output);
		for (const { path: filePath, name: originalFileName } of convertedFiles) {
			archive.file(filePath, { name: originalFileName });
		}
		await archive.finalize();

		progressEmitter.emit('progress', 'All files added to ZIP archive.');

		output.on('close', () => {
			progressEmitter.emit('progress', 'ZIP file ready for download.');
			res.download(zipFilePath, zipFileName, (err) => {
				if (err) console.error('Error sending zip file:', err);
				fs.unlinkSync(zipFilePath); // Delete zip file after download
				// Delete each converted file
				convertedFiles.forEach(({ path }) => {
					fs.unlinkSync(path);
					progressEmitter.emit('progress', `Converted file deleted: ${path}`);
				});
				progressEmitter.emit('progress', 'All files cleaned up after download.');
			});
		});

		output.on('error', (err) => {
			console.error('Error with zip output stream:', err);
			progressEmitter.emit('progress', 'Error creating ZIP file.');
			res.status(500).send('Error creating zip file.');
		});

	} catch (error) {
		console.error('Error during file conversion:', error);
		progressEmitter.emit('progress', 'Error during file conversion.');
		res.status(500).send('Error during file conversion.');
	} finally {
		// Cleanup all files after conversion regardless of success or failure
		cleanupFiles.forEach((filePath) => {
			try {
				fs.unlinkSync(filePath);
				progressEmitter.emit('progress', `Original file deleted after conversion (final cleanup).`);
			} catch (err) {
				console.error('Error deleting original file during final cleanup:', err);
			}
		});
	}
});

app.listen(port, () => {
	console.log(`Server running on http://localhost:${port}`);
});
