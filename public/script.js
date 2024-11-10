let selectedCategory = "images";

const categoryFormats = {
	images: ["png", "jpg", "jpeg", "gif", "bmp", "tiff", "webp", "svg"],
	sound: ["mp3", "wav", "ogg", "flac", "aac", "m4a"],
	videos: ["mp4", "avi", "mkv", "mov", "flv", "webm"],
};

const formatSelect = document.getElementById("formatSelect");
const fileInput = document.getElementById("fileInput");
const dropArea = document.getElementById("dropArea");
const menuButtons = document.querySelectorAll(".menu button");
const terminalMessages = document.getElementById("terminalMessages");
const terminal = document.querySelector(".terminal");

// EventSource setup for streaming messages
let eventSource = null;
let eventSourceOpen = false;

// Display a new message in the terminal
function displayMessage(message) {
	// Skip heartbeat messages
	if (message === undefined)return;

	const messageElement = document.createElement("div");
	messageElement.classList.add("terminal-line");
	messageElement.textContent = message;
	const terminalMessages = document.getElementById("terminalMessages");
	terminalMessages.appendChild(messageElement);

	Array.from(terminalMessages.children).forEach((line, index) => {
		line.classList.toggle(
			"faded",
			index !== terminalMessages.children.length - 1
		);
	});

	terminalMessages.scrollTop = terminalMessages.scrollHeight;
}

// Initialize EventSource
function connectToSSE() {
	// Prevent creating multiple connections
	if (eventSourceOpen) return;

	eventSource = new EventSource("/events");

	eventSource.onmessage = (event) => {
		const data = JSON.parse(event.data);
		displayMessage(data.message);
	};

	eventSource.onerror = (error) => {
		displayMessage(`Error in SSE connection: ${error.message}\n${error.stack}`);
		setTimeout(connectToSSE, 5000); // Attempt reconnect after 5 seconds
	};

	eventSource.onopen = () => (eventSourceOpen = true);
	eventSource.onclose = () => (eventSourceOpen = false);
}

connectToSSE();

// Update format options when category changes
function updateFormatOptions() {
	formatSelect.innerHTML = categoryFormats[selectedCategory]
		.map(
			(format) => `<option value="${format}">${format.toUpperCase()}</option>`
		)
		.join("");
}

// Handle category button clicks
menuButtons.forEach((button) => {
	button.addEventListener("click", () => {
		selectedCategory = button.dataset.category;
		menuButtons.forEach((btn) => btn.classList.remove("active"));
		button.classList.add("active");
		updateFormatOptions();
	});
});

// Ffile selection (drag-and-drop and file input)
fileInput.addEventListener("change", () => handleFileUpload(fileInput.files));
dropArea.addEventListener("click", (event) => {
	event.stopPropagation();
	fileInput.click();
});
// Prevent opening file dialog when clicking format select
formatSelect.addEventListener("click", (event) => {
	event.stopPropagation();
});

// Drag-and-drop animations
dropArea.addEventListener("dragover", (event) => {
	event.preventDefault();
	dropArea.classList.add("hover");
});
dropArea.addEventListener("dragleave", () => {
	dropArea.classList.remove("hover");
});
dropArea.addEventListener("drop", (event) => {
	event.preventDefault();
	dropArea.classList.remove("hover");
	handleFileUpload(event.dataTransfer.files);
});

async function handleFileUpload(files) {
	if (files.length === 0) return;

	const maxSize = 512 * 1024 * 1024; // 512MB
	let totalSize = 0;

	showTerminal();

	for (let file of files) {
		if (file.size > maxSize) {
			displayMessage(`${file.name} exceeds the size limit of 512MB.`);
			return;
		}
		totalSize += file.size;
	}
	if (totalSize > maxSize) {
		displayMessage("Total size of selected files exceeds the 512MB limit.");
		return;
	}

	displayMessage("Sending files for conversion...");

	const formData = new FormData();
	Array.from(files).forEach((file) => formData.append("files", file));
	formData.append("category", selectedCategory);
	formData.append("format", formatSelect.value);

	try {
		const response = await fetch("/convert", {
			method: "POST",
			body: formData,
		});

		if (!response.ok)
			throw new Error("Failed to convert files. Please try again later.");

		const contentDisposition = response.headers.get("Content-Disposition");
		let zipFileName = contentDisposition
			? /filename="(.+)"/.exec(contentDisposition)?.[1] || "converted_files.zip"
			: "converted_files.zip";

		const blob = await response.blob();
		if (blob.size > 0) {
			displayMessage("Conversion complete! Preparing download...");
			const downloadLink = document.createElement("a");
			downloadLink.href = URL.createObjectURL(blob);
			downloadLink.download = zipFileName;
			document.body.appendChild(downloadLink);
			downloadLink.click();
			document.body.removeChild(downloadLink);
		} else throw new Error("The received file is empty or invalid.");
	} catch (error) {
		displayMessage(
			`Error during file conversion: ${error.message}\n${error.stack}`
		);
	}
}

function showTerminal() {
	const terminal = document.querySelector(".terminal");
	terminal.classList.remove("hidden");
	terminal.classList.add("show");
	document.querySelector(".container").classList.add("show-terminal");
}

// Help
const helpBtn = document.getElementById("helpBtn");
const helpBox = document.getElementById("helpBox");
helpBtn.addEventListener("click", () => helpBox.classList.toggle("open"));

updateFormatOptions();
