"""
Serve the project folder locally so the browser can run the web pages.

    .venv\\Scripts\\python serve.py
then open http://localhost:8000/web/  (Ctrl+C to stop)

Why not plain "python -m http.server"? On Windows it can send .js files with
the wrong content type, and browsers refuse to run JavaScript modules then.
"""

import http.server
from pathlib import Path

PORT = 8000


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(Path(__file__).parent), **kwargs)


if __name__ == "__main__":
    print(f"Open http://localhost:{PORT}/web/   (Ctrl+C to stop)")
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
