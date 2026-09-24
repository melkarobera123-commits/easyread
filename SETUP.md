# EasyRead setup

## Local reading features

The app works without an account. Imported books, vocabulary, notes, highlights, bookmarks, and progress stay in the browser's local storage and IndexedDB.

## AI summaries

The optional Node server keeps the model key out of the browser. In PowerShell, set the key directly in your terminal, then start the server:

```powershell
$env:OPENAI_API_KEY = "paste-your-key-here"
node server.js
```

Optional settings:

```powershell
$env:OPENAI_BASE_URL = "https://api.openai.com/v1"
$env:OPENAI_MODEL = "gpt-4o-mini"
```

Never put the key in `app.js`, `index.html`, or a committed file. For another OpenAI-compatible provider, set `OPENAI_BASE_URL` to its `/v1` endpoint and use its model name.