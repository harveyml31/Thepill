# The Pill

A small Claude that floats on your screen. It can see what you see, but only when you let it.

- **The pill** is a small capsule that stays above every window. Drag it anywhere.
- **Click it** and it stretches into a prompt bar right where it sits. Type your question and press Enter.
- **The chat opens in place.** The bar grows into a full Claude chat from that same spot. It stays open and on top when you click on other windows.
- **– (or Esc)** shrinks it back into the pill. If you moved the chat, the pill goes back where the chat was.

It's **the real claude.ai**, signed into your account. It isn't a separate model and it isn't the paid API. Every chat you have in the pill also shows up in the Claude app and on claude.ai, and the other way round. It's free beyond your existing Claude plan.

## Sight: what Claude can see

| Mode | What Claude sees |
|---|---|
| **Screen off** (default) | Nothing. Nothing is captured. |
| **📷 one-off** | Click the camera button (on the bar or in the chat) and Claude gets one screenshot with that question. |
| **👁 Watching** | Every message you send includes a fresh screenshot of what you're looking at. The pill shows a pulsing red ring the whole time, so you always know. |
| **Rewind** (while watching) | Keeps the last few minutes of your screen **in memory only**. Frames are saved only when the screen changes, and nothing ever goes to disk. One click sends Claude a labelled timeline: "what was that error that just flashed up?" It's wiped the moment you turn watching off. |

On macOS and Windows, The Pill hides its own windows from screenshots, so Claude sees your work and not the chat panel. Rewind pauses when your screen is locked or you've been away for a while.

## Install and run

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
git clone https://github.com/harveyml31/Thepill.git
cd Thepill
npm install
npm start
```

The first time you open it, sign in to Claude once. It remembers you after that. If "Sign in with Google" refuses to work inside the app, use email sign-in.

**Build a proper installer** (optional): `npm run dist`. It goes into `dist/` (`.dmg` on Mac, `.exe` on Windows, `.AppImage`/`.deb` on Linux). On a Mac, the first screenshot will ask for **Screen Recording** permission (System Settings → Privacy & Security → Screen Recording). Allow it, then restart The Pill.

## Shortcuts

| | Windows / Linux | macOS |
|---|---|---|
| Open / shrink Claude | `Ctrl+Shift+Space` | `⌘⇧Space` |
| Share screen now | `Ctrl+Shift+Alt+S` | `⌘⇧⌥S` |
| Watching on / off | `Ctrl+Shift+Alt+W` | `⌘⇧⌥W` |

Double-click the pill to go straight to the full chat. Right-click it for everything else.

## Moving chats between the pill and Claude

- **From the pill to the browser:** `⋯ → Open in browser` opens the current chat on claude.ai.
- **From the browser to the pill:** copy a claude.ai chat link, then `⋯ → Open link from clipboard`. Or drag the **→ Send to Pill** bookmarklet (in `⋯`) to your bookmarks bar. Clicking it on any claude.ai chat opens that chat in the pill. This needs the installed build, because it uses the `thepill://` link.
- The chats are the same everywhere, so you can carry on in whichever window you like.

## How it works

- `src/main.js` runs the pill, the chat window, the tray icon, the shortcuts and the screenshots (Electron's `desktopCapturer`).
- The chat window shows claude.ai with your saved login. `src/preload-claude.js` runs inside that page, kept separate from claude.ai's own code. It attaches screenshots to the message box: first through the hidden file input, then a paste event, then a real clipboard paste (your clipboard is restored afterwards). When watching is on, it holds each message for a moment, attaches a fresh screenshot, then sends.
- Screenshots go only to claude.ai, the same as if you'd attached them yourself. Settings are saved locally. Rewind frames live only in memory.

## Known limits

- **Claude answers when you send a message.** It sees your screen with every message while watching, but it doesn't comment on its own. Proactive commentary would need the paid API.
- **claude.ai can change its page at any time.** If attaching ever breaks, your message still sends without the screenshot and you'll see a warning. File an issue and the selectors in `preload-claude.js` can be updated.
- **Linux** can't hide The Pill from its own screenshots. On Wayland your desktop may ask you to approve each capture.

## Development

```bash
npm run icons                                                # regenerate icons (needs Python + Pillow)
xvfb-run -a npx electron --no-sandbox test/e2e-main.js       # end-to-end test against a fake claude.ai page
```
