# 🛡️ InstaGuard AI

### AI-Powered Instagram Misinformation & Deepfake Detection Extension

InstaGuard AI is a Chrome browser extension that analyzes Instagram posts, reels, and captions in real-time to detect misinformation, manipulated media, and AI-generated content. It combines Google's Gemini AI with trusted fact-checking sources to help users make informed decisions while browsing social media.

---

## 🚀 Problem Statement

Social media platforms are flooded with:

- Fake news
- AI-generated misinformation
- Deepfake videos and images
- Misleading captions and claims

Most users cannot verify information instantly while scrolling.

InstaGuard AI solves this problem by providing real-time credibility analysis directly on Instagram.

---

## ✨ Features

### 🔍 Real-Time Content Analysis
- Automatically analyzes Instagram posts, captions, and reels.
- Runs silently in the background.

### 🤖 Gemini AI Verification
- Uses Google's Gemini AI to evaluate claims.
- Generates confidence scores and reasoning.

### 📰 Cross-Source Fact Checking
- Verifies information using:
  - NewsAPI
  - PIB Fact Check (Government of India)

### ⚠️ Credibility Badges
Posts receive visual indicators such as:

- ✅ Likely True
- ⚠️ Verify This
- ❌ Potential Misinformation

### 📊 Detailed Fact Check Panel
One-click analysis panel showing:
- Confidence score
- AI reasoning
- Supporting evidence
- Fact-check references

### ⛓️ Community Trust Layer
Community reports are stored on Polygon Testnet to create transparent and tamper-resistant reporting records.

### 🔒 Privacy First
- No login required
- No user data collection
- Analysis performed only on visible content

---

## 🛠️ Tech Stack

| Technology | Purpose |
|------------|----------|
| HTML | Extension UI |
| CSS | Styling |
| JavaScript | Core functionality |
| Gemini AI | Claim verification |
| NewsAPI | News cross-verification |
| PIB Fact Check | Official fact-check source |
| Polygon Testnet | Decentralized community reports |
| Chrome Extension APIs | Browser integration |

---

## 📂 Project Structure

```
INSTAGUARD_FINAL/
│
├── icons/
├── src/
├── manifest.json
├── Landing page.html
└── README.md
```

---

## ⚙️ Installation

### Clone Repository

```bash
git clone https://github.com/Badal-devlop/INSTAGUARD_FINAL.git
```

### Load Extension

1. Open Chrome
2. Go to `chrome://extensions`
3. Enable **Developer Mode**
4. Click **Load Unpacked**
5. Select the project folder

The extension will now be active.

---

## 🎯 How It Works

1. User opens Instagram.
2. InstaGuard AI monitors visible content.
3. Gemini AI evaluates claims and captions.
4. NewsAPI and PIB Fact Check validate information.
5. Credibility score is generated.
6. Warning badge is displayed when needed.
7. Community reports can be recorded on Polygon.

---

## 📸 Screenshots

Add screenshots of:

- Landing Page
- Extension Popup
- Fact Check Panel
- Misinformation Warning Badge

---

## 🌟 Future Improvements

- Deepfake image detection model
- Multilingual fact checking
- Crowd-sourced reputation scoring
- Support for X (Twitter), Facebook, and YouTube
- Mobile browser support

---

## 👨‍💻 Team

Built for **HackSphere Hackathon 2026**

### Team InstaGuard AI

- Subhomita Ghosh
- Badal 
- Soumili Roy
- Zinnia choudhury
  

---

## 🔗 Live Demo

GitHub Pages:

https://badal-devlop.github.io/INSTAGUARD_FINAL/

---

## 📜 License

This project is developed for educational and hackathon purposes.
