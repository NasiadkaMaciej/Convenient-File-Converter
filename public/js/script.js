const MAX_FILE_SIZE = 256 * 1024 * 1024; // 256MB
const MAX_TOTAL_SIZE = 256 * 1024 * 1024; // 256MB
const sessionId = Math.random().toString(36).substring(2, 10);

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

// Allowed formats and MIME types
const categoryFormats = {
	images: ["png", "jpg", "jpeg", "gif", "bmp", "tiff", "webp", "svg", "heic", "heif", "avif"],
	sounds: ["mp3", "wav", "ogg", "flac", "aac", "m4a"],
	videos: ["mp4", "avi", "mkv", "mov", "flv", "webm"],
};

const allowedMimeTypes = {
	images: ["image/png", "image/jpeg", "image/gif", "image/bmp", "image/tiff", "image/webp", "image/svg", "image/heic", "image/heif", "image/avif"],
	sounds: ["audio/mpeg", "audio/wav", "audio/ogg", "audio/flac", "audio/aac", "audio/mp4"],
	videos: ["video/mp4", "video/x-msvideo", "video/x-matroska", "video/quicktime", "video/x-flv", "video/webm"],
};

// Utility Functions
const sanitizeFilename = (filename) => filename.replace(/[^a-zA-Z0-9.\-_]/g, "_");

function displayMessage(message, isError = false) {
	if (!message) return;

	const messageElement = document.createElement("div");
	messageElement.classList.add("terminal-line");
	if (isError) messageElement.classList.add("error");
	messageElement.textContent = message;
	terminalMessages.appendChild(messageElement);
	terminalMessages.scrollTop = terminalMessages.scrollHeight;
}

function showTerminal() {
	terminal.classList.remove("hidden");
	terminal.classList.add("show");
}


function connectToSSE() {
	if (eventSource) return;
	eventSource = new EventSource(`/events/${sessionId}`);
	eventSource.onmessage = (event) => displayMessage(JSON.parse(event.data).message);

	eventSource.onerror = () => {
		displayMessage(`Error in SSE connection: ${error.message}\n${error.stack}. Reconnecting...`);
		closeEventSource()
		setTimeout(connectToSSE, 5000); // Retry connection after 5 seconds
	};
}

function closeEventSource() {
	if (eventSource) {
		eventSource.close();
		eventSource = null;
	}
}

function updateFormatOptions() {
	formatSelect.innerHTML = categoryFormats[selectedCategory]
		.map((format) => `<option value="${format}">${format.toUpperCase()}</option>`)
		.join("");
}

// File Validation
function validateFiles(files) {
	let totalSize = 0;
	for (const file of files) {
		if (!allowedMimeTypes[selectedCategory].includes(file.type)) {
			displayMessage(`${file.name} has an unsupported format. Please select the correct category.`, true);
			return false;
		}

		if (file.size > MAX_FILE_SIZE) {
			displayMessage(`${file.name} exceeds the size limit of 256MB.`, true);
			return false;
		}

		totalSize += file.size;
		if (totalSize > MAX_TOTAL_SIZE) {
			displayMessage("Total size of selected files exceeds the 256MB limit.", true);
			return false;
		}
	}
	return true;
}

// File Upload
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
		if (!response.ok) throw new Error("Conversion failed. Please try again.");

		const blob = await response.blob();
		const contentDisposition = response.headers.get("Content-Disposition");
		const filename = contentDisposition?.match(/filename="(.+)"/)?.[1] || "converted_files.zip";

		displayMessage("Conversion complete!");
		const link = document.createElement("a");
		link.href = URL.createObjectURL(blob);
		link.download = sanitizeFilename(filename);
		link.click();
	} catch (error) {
		displayMessage(`Error: ${error.message}`, true);
	} finally {
		isUploading = false;
		closeEventSource();
	}
}

// Event Listeners
menuButtons.forEach((button) =>
	button.addEventListener("click", () => {
		selectedCategory = button.dataset.category;
		menuButtons.forEach((btn) => btn.classList.remove("active"));
		button.classList.add("active");
		updateFormatOptions();
	})
);

fileInput.addEventListener("change", () => {
	if (validateFiles(fileInput.files)) uploadFiles(fileInput.files);
});

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

helpBtn.addEventListener("click", () => helpBox.classList.toggle("open"));

formatSelect.addEventListener("click", (e) => e.stopPropagation());

updateFormatOptions();