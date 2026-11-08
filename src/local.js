import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 6;
const MAX_PLAYERS = 2;
const MAX_MESSAGE_BYTES = 8192;
const MAX_PROFILE_BYTES = 4 * 1024 * 1024;
const MAX_PROFILE_CHUNKS = 2048;
const PROFILE_CHUNK_CHARS = 4800;
const MAX_HTTP_BODY_BYTES = 4096;
const ROOM_LIFETIME_MS = 2 * 60 * 60 * 1000;
const rooms = new Map();
const port = Number(process.env.PORT) || 8787;

function jsonResponse(response, status, body) {
	const text = JSON.stringify(body);
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(text),
		"Cache-Control": "no-store",
	});
	response.end(text);
}

function randomCode(length) {
	const bytes = randomBytes(length);
	return Array.from(bytes, (value) => CODE_ALPHABET[value % CODE_ALPHABET.length]).join("");
}

function cleanNickname(value) {
	if (typeof value !== "string") return null;
	const nickname = value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 20);
	return nickname.length > 0 ? nickname : null;
}

function hasControlCharacters(value) {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code < 32 || code === 127) return true;
	}
	return false;
}

function isRoomCode(value) {
	return typeof value === "string" &&
		new RegExp(`^[${CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`).test(value);
}

function readBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let length = 0;
		request.on("data", (chunk) => {
			length += chunk.length;
			if (length > MAX_HTTP_BODY_BYTES) {
				reject(new Error("body_too_large"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}

function createRoom(hostName) {
	for (let attempt = 0; attempt < 8; attempt++) {
		const code = randomCode(ROOM_CODE_LENGTH);
		const existing = rooms.get(code);
		if (existing && Date.now() - existing.createdAt < ROOM_LIFETIME_MS) continue;
		const room = {
			code,
			hostName,
			hostToken: randomCode(32),
			createdAt: Date.now(),
			hostPeer: null,
			peers: new Map(),
			profileUpload: null,
			profileSnapshot: null,
			currentTransition: null,
			transitionSequence: 0,
			weatherEnabled: false,
			closed: false,
		};
		rooms.set(code, room);
		return room;
	}
	return null;
}

function roster(room) {
	return Array.from(room.peers.values(), (peer) => peer.player);
}

function broadcast(room, message, predicate = () => true) {
	for (const peer of room.peers.values()) {
		if (predicate(peer.player)) peer.sendJson(message);
	}
}

function broadcastRoster(room) {
	broadcast(room, { type: "roster", players: roster(room) });
}

function sendProfileSnapshot(peer, snapshot) {
	if (!peer || !snapshot) return;
	peer.sendJson({
		type: "profile_begin",
		transferId: snapshot.transferId,
		byteLength: snapshot.byteLength,
		chunkCount: snapshot.chunks.length,
	});
	for (let index = 0; index < snapshot.chunks.length; index++) {
		peer.sendJson({
			type: "profile_chunk",
			transferId: snapshot.transferId,
			index,
			data: snapshot.chunks[index],
		});
	}
	peer.sendJson({ type: "profile_end", transferId: snapshot.transferId });
}

function sendFrame(socket, opcode, payload) {
	if (socket.destroyed || socket.writableEnded) return;
	const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
	let header;
	if (data.length < 126) {
		header = Buffer.from([0x80 | opcode, data.length]);
	} else if (data.length <= 0xffff) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 126;
		header.writeUInt16BE(data.length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(data.length), 2);
	}
	socket.write(Buffer.concat([header, data]));
}

class WebSocketPeer {
	constructor(socket, room, player) {
		this.socket = socket;
		this.room = room;
		this.player = player;
		this.buffer = Buffer.alloc(0);
		this.disconnected = false;
		socket.setNoDelay(true);
		socket.on("data", (chunk) => this.onData(chunk));
		socket.on("error", () => this.onDisconnect());
		socket.on("end", () => this.onDisconnect());
		socket.on("close", () => this.onDisconnect());
	}

	sendJson(message) {
		/* Position packets are replaceable; avoid buffering seconds of stale movement. */
		if (message?.type === "state" && this.socket.writableLength > 512) return;
		const text = JSON.stringify(message);
		if (Buffer.byteLength(text) <= MAX_MESSAGE_BYTES) sendFrame(this.socket, 1, text);
	}

	close(code = 1000, reason = "Leaving room") {
		if (this.socket.destroyed || this.socket.writableEnded) return;
		const text = Buffer.from(String(reason).slice(0, 100), "utf8");
		const payload = Buffer.alloc(2 + text.length);
		payload.writeUInt16BE(code, 0);
		text.copy(payload, 2);
		sendFrame(this.socket, 8, payload);
		this.socket.end();
	}

	onData(chunk) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (this.readFrame()) {
			// Process complete frames until the next partial frame.
		}
	}

	readFrame() {
		if (this.buffer.length < 2) return false;
		const first = this.buffer[0];
		const second = this.buffer[1];
		const opcode = first & 0x0f;
		const masked = (second & 0x80) !== 0;
		if ((first & 0x70) !== 0 || (first & 0x80) === 0 || !masked) {
			this.close(1002, "Invalid WebSocket frame");
			return false;
		}

		let payloadLength = second & 0x7f;
		let headerLength = 2;
		if (payloadLength === 126) {
			if (this.buffer.length < 4) return false;
			payloadLength = this.buffer.readUInt16BE(2);
			headerLength = 4;
		} else if (payloadLength === 127) {
			if (this.buffer.length < 10) return false;
			const longLength = this.buffer.readBigUInt64BE(2);
			if (longLength > BigInt(MAX_MESSAGE_BYTES)) {
				this.close(1009, "Message too large");
				return false;
			}
			payloadLength = Number(longLength);
			headerLength = 10;
		}
		if (payloadLength > MAX_MESSAGE_BYTES) {
			this.close(1009, "Message too large");
			return false;
		}
		if (this.buffer.length < headerLength + 4 + payloadLength) return false;

		const mask = this.buffer.subarray(headerLength, headerLength + 4);
		const payload = Buffer.from(this.buffer.subarray(headerLength + 4, headerLength + 4 + payloadLength));
		this.buffer = this.buffer.subarray(headerLength + 4 + payloadLength);
		for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];

		if (opcode === 1) {
			this.onMessage(payload.toString("utf8"));
		} else if (opcode === 8) {
			this.close(1000, "Closed by client");
		} else if (opcode === 9) {
			sendFrame(this.socket, 10, payload);
		} else if (opcode !== 10) {
			this.close(1003, "Only text messages are supported");
		}
		return true;
	}

	onMessage(text) {
		if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) {
			this.close(1009, "Message too large");
			return;
		}
		let body;
		try {
			body = JSON.parse(text);
		} catch {
			this.close(1007, "Invalid JSON");
			return;
		}
		if (this.room.closed) return;
		if (body.type === "ping") {
			this.sendJson({ type: "pong", at: Date.now() });
			return;
		}
		if (body.type === "input") {
			const validAction = ["move", "jump", "swing", "use"].includes(body.action);
			const validValue = body.action === "move"
				? [-1, 0, 1].includes(body.value)
				: typeof body.value === "boolean";
			if (!validAction || !validValue) return;
			const remoteRole = this.player.role === "host" ? "guest" : "host";
			for (const peer of this.room.peers.values()) {
				if (peer.player.role !== remoteRole) continue;
				peer.sendJson({
					type: "input",
					fromId: this.player.id,
					fromName: this.player.name,
					action: body.action,
					value: body.value,
				});
			}
			return;
		}
		if (body.type === "state") {
			if (typeof body.data !== "object" || body.data === null || Array.isArray(body.data)) return;
			const remoteRole = this.player.role === "host" ? "guest" : "host";
			broadcast(this.room, { type: "state", data: body.data }, (player) => player.role === remoteRole);
			return;
		}
		if (body.type === "weather" && typeof body.enabled === "boolean") {
			this.room.weatherEnabled = body.enabled;
			broadcast(this.room, { type: "weather", enabled: body.enabled });
			return;
		}
		if (body.type === "transition" && this.player.role === "host") {
			const level = typeof body.level === "string" ? body.level : "";
			const spawn = typeof body.spawn === "string" ? body.spawn : "";
		if (!level || !spawn || level.length > 128 || spawn.length > 128 ||
		    hasControlCharacters(level) || hasControlCharacters(spawn)) return;
			const transition = {
				type: "transition",
				level,
				spawn,
				sequence: ++this.room.transitionSequence,
			};
			this.room.currentTransition = transition;
			broadcast(this.room, transition, (player) => player.role === "guest");
			return;
		}
		if (body.type === "profile_begin" && this.player.role === "host") {
			const transferId = typeof body.transferId === "string" ? body.transferId : "";
			const byteLength = body.byteLength;
			const chunkCount = body.chunkCount;
			const encodedLength = Math.ceil(byteLength / 3) * 4;
			const expectedChunks = Math.ceil(encodedLength / PROFILE_CHUNK_CHARS);
			if (!/^[a-zA-Z0-9-]{1,64}$/.test(transferId) ||
			    !Number.isInteger(byteLength) || byteLength < 1 || byteLength > MAX_PROFILE_BYTES ||
			    !Number.isInteger(chunkCount) || chunkCount !== expectedChunks || chunkCount > MAX_PROFILE_CHUNKS) return;
			this.room.profileUpload = { transferId, byteLength, chunkCount, chunks: new Array(chunkCount) };
			return;
		}
		if (body.type === "profile_chunk" && this.player.role === "host") {
			const upload = this.room.profileUpload;
			if (!upload || body.transferId !== upload.transferId ||
			    !Number.isInteger(body.index) || body.index < 0 || body.index >= upload.chunkCount ||
			    typeof body.data !== "string" || body.data.length < 1 ||
			    body.data.length > PROFILE_CHUNK_CHARS || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) return;
			upload.chunks[body.index] = body.data;
			return;
		}
		if (body.type === "profile_end" && this.player.role === "host") {
			const upload = this.room.profileUpload;
			if (!upload || body.transferId !== upload.transferId || upload.chunks.some((chunk) => typeof chunk !== "string")) return;
			const encoded = upload.chunks.join("");
			const profileBytes = Buffer.from(encoded, "base64");
			if (profileBytes.length !== upload.byteLength) {
				this.room.profileUpload = null;
				return;
			}
			const snapshot = {
				transferId: upload.transferId,
				byteLength: upload.byteLength,
				chunks: upload.chunks,
			};
			this.room.profileSnapshot = snapshot;
			this.room.profileUpload = null;
			for (const peer of this.room.peers.values()) {
				if (peer.player.role === "guest") sendProfileSnapshot(peer, snapshot);
			}
			this.sendJson({ type: "profile_snapshot", status: "ready", byteLength: snapshot.byteLength });
			return;
		}
		if (body.type === "chat" && typeof body.text === "string") {
			const message = body.text.trim().slice(0, 200);
			if (!message) return;
			broadcast(this.room, {
				type: "chat",
				fromId: this.player.id,
				fromName: this.player.name,
				text: message,
			});
		}
	}

	onDisconnect() {
		if (this.disconnected) return;
		this.disconnected = true;
		const room = this.room;
		if (room.closed) return;
		if (this.player.role === "host") {
			room.closed = true;
			rooms.delete(room.code);
			for (const peer of room.peers.values()) {
				if (peer === this) continue;
				peer.sendJson({ type: "room_closed", reason: "host_left" });
				peer.close(1000, "Host left the room");
			}
			room.peers.clear();
			return;
		}
		room.peers.delete(this.player.id);
		broadcastRoster(room);
	}
}

const server = createServer(async (request, response) => {
	const url = new URL(request.url, "http://127.0.0.1");
	if (url.pathname === "/health" && request.method === "GET") {
		jsonResponse(response, 200, {
			ok: true,
			service: "swordigo-coop-relay",
			protocolVersion: 2,
			features: ["room_weather"],
		});
		return;
	}
	if (url.pathname === "/api/rooms" && request.method === "POST") {
		let body;
		try {
			const text = await readBody(request);
			body = JSON.parse(text);
		} catch {
			jsonResponse(response, 400, { error: "invalid_json" });
			return;
		}
		const hostName = cleanNickname(body.nickname);
		if (!hostName) {
			jsonResponse(response, 400, { error: "invalid_nickname" });
			return;
		}
		const room = createRoom(hostName);
		if (!room) {
			jsonResponse(response, 503, { error: "could_not_create_room" });
			return;
		}
		jsonResponse(response, 200, { code: room.code, hostToken: room.hostToken });
		return;
	}
	jsonResponse(response, 404, { error: "not_found" });
});

server.on("upgrade", (request, socket, head) => {
	const url = new URL(request.url, "http://127.0.0.1");
	const match = url.pathname.match(/^\/ws\/([A-Z0-9]+)$/);
	const code = match?.[1];
	const room = code && rooms.get(code);
	if (!isRoomCode(code) || !room || room.closed || Date.now() - room.createdAt >= ROOM_LIFETIME_MS) {
		socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
		return;
	}
	const role = url.searchParams.get("role");
	const nickname = cleanNickname(url.searchParams.get("nickname"));
	if (!nickname || (role !== "host" && role !== "guest")) {
		socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
		return;
	}
	if (role === "host") {
		const authorization = request.headers.authorization || "";
		const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
		if (!token || token !== room.hostToken || room.hostPeer) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			return;
		}
	} else if (!room.hostPeer) {
		socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");
		return;
	}
	if (room.peers.size >= MAX_PLAYERS) {
		socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");
		return;
	}
	const key = request.headers["sec-websocket-key"];
	if (!key || request.headers.upgrade?.toLowerCase() !== "websocket") {
		socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
		return;
	}
	const accept = createHash("sha1")
		.update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
		.digest("base64");
	socket.write(
		"HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		`Sec-WebSocket-Accept: ${accept}\r\n\r\n`
	);
	const player = {
		id: role === "host" ? "host" : randomCode(12),
		name: nickname,
		role,
	};
	const peer = new WebSocketPeer(socket, room, player);
	room.peers.set(player.id, peer);
	if (role === "host") room.hostPeer = peer;
	peer.sendJson({ type: "welcome", playerId: player.id, roomCode: room.code });
	peer.sendJson({ type: "weather", enabled: room.weatherEnabled });
	broadcastRoster(room);
	if (role === "guest" && room.profileSnapshot) sendProfileSnapshot(peer, room.profileSnapshot);
	if (role === "guest" && room.currentTransition) peer.sendJson(room.currentTransition);
	if (head && head.length > 0) peer.onData(head);
});

server.listen(port, "0.0.0.0", () => {
	console.log(`Swordigo co-op relay ready on port ${port}`);
});

server.on("error", (error) => {
	console.error("Could not start the local co-op relay:", error.message);
	process.exitCode = 1;
});
