// === FINALIZED & ENHANCED script.js for Chat X ===
let socket;
let username;
let authToken;
let selectedRecipient = null;





console.log("✅ script.js loaded!");

window.onload = async function () {
  username = localStorage.getItem("username");
  const password = localStorage.getItem("password");

  if (!username || !password) {
    alert("Login info not found. Redirecting to login page.");
    window.location.href = "login.html";
    return;
  }

  // ✅ Update welcome message here after username is available
  const welcomeElement = document.querySelector(".welcome");
  if (welcomeElement) {
    welcomeElement.textContent = `Welcome, ${username}`;
  }

  try {
    const res = await fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Login failed");

    authToken = data.token || "dummy-token";
    connectWebSocket();
  } catch (err) {
    console.error("Auto-login failed:", err);
    alert("Session expired or server error. Please login again.");
    window.location.href = "login.html";
  }
};


function connectWebSocket() {
  try {
    socket = new WebSocket("wss://chat-x-1-9.onrender.com");
    console.log("📡 Connecting WebSocket...");
  } catch (err) {
    console.error("❌ Failed to create WebSocket:", err);
    return;
  }

  socket.onopen = () => {
    console.log("✅ WebSocket opened");
    socket.send(JSON.stringify({ type: "connect", username, token: authToken }));
  };

  socket.onmessage = handleSocketMessage;
  socket.onerror = (e) => {
    console.error("❌ WebSocket error:", e);
    alert("WebSocket error. Please refresh.");
  };
  socket.onclose = () => console.warn("🔌 WebSocket disconnected");
}

function handleSocketMessage(event) {
  const data = JSON.parse(event.data);
  if (data.type === "updateUsers") {
    const container = document.getElementById("user-items-container");
    container.innerHTML = "";
    data.users.forEach(user => {
      if (user !== username) {
        const el = document.createElement("div");
        el.textContent = user;
        el.className = "user-item";
        el.onclick = async () => {
          selectedRecipient = user;
          document.getElementById("chat-box").innerHTML = "";
          document.getElementById("chat-title").textContent = `${user}`;
          document.querySelector(".status-indicator").style.backgroundColor = "#00ff88"; // show green dot


          // Fetch message history
          try {
            const history = await fetch(`/history?user=${username}&peer=${user}`);
            const messages = await history.json();
            messages.forEach(renderMessage);
          } catch (err) {
            console.error("Failed to load chat history", err);
          }
        };
        container.appendChild(el);
      }
    });
  } else if (data.type === "message") {
    updateEmoji(data.mood); // 👈 Add this line to update the emoji
    renderMessage(data);
  }
   else if (data.type === "typing") {
    showTypingIndicator(data.sender);
  }
}

function renderStatus(text) {
  const status = document.createElement("div");
  status.className = "message status";
  status.textContent = text;
  document.getElementById("chat-box").appendChild(status);
}

function renderMessage({ sender, message, timestamp }) {
  const templateId = sender === username ? "message-template-sent" : "message-template-received";
  const template = document.getElementById(templateId);
  const clone = template.content.cloneNode(true);

  clone.querySelector(".content").textContent = message;
  const meta = clone.querySelector(".meta");
  const time = new Date(timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  meta.textContent = time;

  if (sender !== username) {
    clone.querySelector(".sender").textContent = sender;
  }

  const box = document.getElementById("chat-box");
  box.appendChild(clone);
  box.scrollTop = box.scrollHeight;
}

const sendBtn = document.getElementById("send-btn");
const messageInput = document.getElementById("message");

sendBtn?.addEventListener("click", () => {
  const text = messageInput.value.trim();
  if (!text || !selectedRecipient) return;

  const payload = {
    type: "message",
    sender: username,
    recipient: selectedRecipient,
    message: text,
    timestamp: Date.now()
  };
  socket.send(JSON.stringify(payload));
  renderMessage(payload); // show own msg
  messageInput.value = "";
});

messageInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendBtn.click();
  else if (selectedRecipient) {
    socket.send(JSON.stringify({ type: "typing", sender: username, recipient: selectedRecipient }));
  }
});

function showTypingIndicator(sender) {
  const indicatorId = `typing-${sender}`;
  if (document.getElementById(indicatorId)) return;

  const div = document.createElement("div");
  div.id = indicatorId;
  div.className = "message status";
  div.textContent = `${sender} is typing...`;
  document.getElementById("chat-box").appendChild(div);

  setTimeout(() => {
    const el = document.getElementById(indicatorId);
    if (el) el.remove();
  }, 3000);
}


function updateEmoji(mood) {
  const emojiMap = {
    happy: "😄",
    sad: "😢",
    angry: "😠",
    neutral: "😐"
  };
  const emojiEl = document.getElementById("live-emoji");
  if (emojiEl) emojiEl.textContent = emojiMap[mood] || "😐";
}
