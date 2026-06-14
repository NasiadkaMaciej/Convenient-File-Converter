// Limits and format lists are loaded from the server (/api/config) so the
// client always stays in sync with the backend. Sensible fallbacks are used
// if the request fails.
let MAX_FILE_SIZE = 256 * 1024 * 1024; // 256MB
let MAX_TOTAL_SIZE = 512 * 1024 * 1024;
let MAX_FILES = 20;

const sessionId =
	(window.crypto && typeof crypto.randomUUID === "function"
		? crypto.randomUUID()
		: Date.now().toString(36) + Math.random().toString(36).slice(2));

// States
let selectedCategory = "images";
let eventSource = null;
let isUploading = false;

// DOM Elements
const formatSelect = document.getElementById("formatSelect");
const fileInput = document.getElementById("fileInput");
const dropArea = document.getElementById("dropArea");
const menuButtons = document.querySelectorAll(".menu button");
const terminalMessages = document.getElementById("terminalMessages");
const terminal = document.querySelector(".terminal");
const helpBtn = document.getElementById("helpBtn");
const helpBox = document.getElementById("helpBox");

// Allowed formats and MIME types (populated from /api/config).
let categoryFormats = {
	images: ["png", "jpg", "jpeg", "gif", "bmp", "tiff", "webp", "avif"],
	sounds: ["mp3", "wav", "ogg", "flac"],
	videos: ["mp4", "avi", "mkv", "mov", "webm"],
};

let allowedMimeTypes = {
	images: ["image/png", "image/jpeg", "image/gif", "image/bmp", "image/tiff", "image/webp", "image/avif"],
	sounds: ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/ogg", "audio/flac", "audio/x-flac", "audio/aac", "audio/mp4"],
	videos: ["video/mp4", "video/x-msvideo", "video/x-matroska", "video/quicktime", "video/x-flv", "video/webm"],
};

// Fetch the authoritative format/limit configuration from the server.
async function loadConfig() {
	try {
		const response = await fetch("/api/config");
		if (!response.ok) return;
		const config = await response.json();
		if (config.categoryFormats) categoryFormats = config.categoryFormats;
		if (config.allowedMimeTypes) allowedMimeTypes = config.allowedMimeTypes;
		if (config.limits) {
			MAX_FILE_SIZE = config.limits.maxFileSize ?? MAX_FILE_SIZE;
			MAX_TOTAL_SIZE = config.limits.maxTotalSize ?? MAX_TOTAL_SIZE;
			MAX_FILES = config.limits.maxFiles ?? MAX_FILES;
		}
		updateFormatOptions();
	} catch {
		/* keep fallback defaults */
	}
}

// Utility: Sanitize filename for download
function sanitizeFilename(filename) {
	return filename.replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

// Utility: Display a message in the terminal area
function displayMessage(message, isError = false) {
	if (!terminalMessages || !message) return;
	const messageElement = document.createElement("div");
	messageElement.classList.add("terminal-line");
	if (isError) messageElement.classList.add("error");
	messageElement.textContent = message;
	terminalMessages.appendChild(messageElement);
	terminalMessages.scrollTop = terminalMessages.scrollHeight;
}

// Utility: Show the terminal area
function showTerminal() {
	if (terminal) {
		terminal.classList.remove("hidden");
		terminal.classList.add("show");
	}
}

// Connect to server-sent events for progress updates
function connectToSSE() {
	if (eventSource) return;
	try {
		eventSource = new EventSource(`/events/${sessionId}`);
		eventSource.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data);
				displayMessage(data.message);
			} catch (e) {
				displayMessage("Malformed progress message.", true);
			}
		};
		eventSource.onerror = (error) => {
			let errorMsg = "Error in SSE connection.";
			if (error && error.message) errorMsg += " " + error.message;
			if (error && error.stack) errorMsg += "\n" + error.stack;
			errorMsg += " Reconnecting...";
			displayMessage(errorMsg, true);
			closeEventSource();
			setTimeout(connectToSSE, 5000); // Retry connection after 5 seconds
		};
	} catch (e) {
		displayMessage("Failed to connect to progress stream.", true);
	}
}

// Close the SSE connection
function closeEventSource() {
	if (eventSource) {
		eventSource.close();
		eventSource = null;
	}
}

// Update the format dropdown based on selected category
function updateFormatOptions() {
	if (!formatSelect) return;
	formatSelect.innerHTML = categoryFormats[selectedCategory]
		.map((format) => `<option value="${format}">${format.toUpperCase()}</option>`)
		.join("");
}

// Validate files before upload
function validateFiles(files) {
	if (files.length > MAX_FILES) {
		displayMessage(`You can convert at most ${MAX_FILES} files at once.`, true);
		return false;
	}
	let totalSize = 0;
	for (const file of files) {
		if (!allowedMimeTypes[selectedCategory].includes(file.type)) {
			displayMessage(file.name + " has an unsupported format. Please select the correct category.", true);
			return false;
		}
		if (file.size > MAX_FILE_SIZE) {
			displayMessage(`${file.name} exceeds the size limit of ${Math.round(MAX_FILE_SIZE / (1024 * 1024))}MB.`, true);
			return false;
		}
		totalSize += file.size;
		if (totalSize > MAX_TOTAL_SIZE) {
			displayMessage(`Total size of selected files exceeds the ${Math.round(MAX_TOTAL_SIZE / (1024 * 1024))}MB limit.`, true);
			return false;
		}
	}
	return true;
}

// Upload files to the server
async function uploadFiles(files) {
	if (isUploading) return;
	isUploading = true;

	showTerminal();
	connectToSSE();
	displayMessage("Uploading files...");

	const formData = new FormData();
	Array.from(files).forEach((file) => formData.append("files", file));
	formData.append("category", selectedCategory);
	formData.append("format", formatSelect.value);
	formData.append("sessionId", sessionId);

	try {
		const response = await fetch("/convert", { method: "POST", body: formData });
		if (!response.ok) {
			let errorText = "Conversion failed. Please try again.";
			try {
				errorText = await response.text();
			} catch {}
			throw new Error(errorText);
		}

		const blob = await response.blob();
		const contentDisposition = response.headers.get("Content-Disposition");
		let filename = "converted_files.zip";
		if (contentDisposition) {
			const match = contentDisposition.match(/filename="(.+)"/);
			if (match && match[1]) filename = match[1];
		}

		displayMessage("Conversion complete!");
		const link = document.createElement("a");
		link.href = URL.createObjectURL(blob);
		link.download = sanitizeFilename(filename);
		document.body.appendChild(link);
		link.click();
		setTimeout(() => {
			URL.revokeObjectURL(link.href);
			document.body.removeChild(link);
		}, 1000);
	} catch (error) {
		displayMessage("Error: " + (error && error.message ? error.message : error), true);
	} finally {
		isUploading = false;
		closeEventSource();
	}
}

// --- Event Listeners ---

// Category menu buttons
if (menuButtons && menuButtons.length) {
	menuButtons.forEach((button) =>
		button.addEventListener("click", () => {
			selectedCategory = button.dataset.category;
			menuButtons.forEach((btn) => btn.classList.remove("active"));
			button.classList.add("active");
			updateFormatOptions();
		})
	);
}

// File input change
if (fileInput) {
	fileInput.addEventListener("change", () => {
		if (validateFiles(fileInput.files)) uploadFiles(fileInput.files);
	});
}

// Drag and drop area
if (dropArea) {
	dropArea.addEventListener("dragover", (e) => {
		e.preventDefault();
		dropArea.classList.add("hover");
	});
	dropArea.addEventListener("dragleave", () => dropArea.classList.remove("hover"));
	dropArea.addEventListener("drop", (e) => {
		e.preventDefault();
		dropArea.classList.remove("hover");
		if (validateFiles(e.dataTransfer.files)) uploadFiles(e.dataTransfer.files);
	});
	// Allow clicking the drop area to open the file picker
	dropArea.addEventListener("click", () => {
		if (fileInput) fileInput.click();
	});
}

// Help button
if (helpBtn && helpBox) {
	helpBtn.addEventListener("click", () => helpBox.classList.toggle("open"));
}

// Prevent dropdown from closing on click
if (formatSelect) {
	formatSelect.addEventListener("click", (e) => e.stopPropagation());
}

// Initialize format options on load, then sync with the server.
updateFormatOptions();
loadConfig();