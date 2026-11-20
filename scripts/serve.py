"""
scripts/serve.py — drop-in replacement for `python -m http.server 8765 --directory web`.

Why: the stock http.server sends no Cache-Control header, so browsers heuristically
cache HTML and ES modules. After you edit a file, a normal reload can keep running the
OLD code (stale main.js / story.html) and the page looks broken or "does nothing".
This server adds `Cache-Control: no-store` and guarantees JS is served as
text/javascript (Windows registry settings can otherwise make Python serve it as
text/plain, which browsers refuse for ES modules).

Usage:  python scripts/serve.py [port]      (default 8765, serves ./web)
"""
import http.server
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web')


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.json': 'application/json',
        '.css': 'text/css',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, max-age=0')
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    handler = lambda *a, **kw: NoCacheHandler(*a, directory=ROOT, **kw)  # noqa: E731
    with http.server.ThreadingHTTPServer(('', port), handler) as httpd:
        print(f'Serving {os.path.normpath(ROOT)} on http://localhost:{port}/  (no-store)')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nStopped.')


if __name__ == '__main__':
    main()
