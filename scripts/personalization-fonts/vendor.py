"""Vendor unmodified web-font subsets; runtime never contacts font providers.

Run from the repository root. The versioned output is immutable once published.
Only CSS family aliases/URLs are changed; font binaries and Unicode ranges stay
as supplied by the upstream web-font services. Keep their licenses alongside.
"""
import concurrent.futures
import hashlib
import json
import pathlib
import re
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "packages/lmc-app/public/fonts/personalization-v2"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
SOURCES = {
    "misans": ("LMC MiSans", ["https://font.sec.miui.com/font/css?family=MiSans:400,600:Chinese_Simplify,Latin&display=swap"]),
    "wenkai": ("LMC WenKai", [f"https://fontsapi.zeoseven.com/292/{style}/result.css" for style in ("main", "medium")]),
    "newsreader": ("LMC Newsreader", ["https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,14..72,200..800;1,14..72,200..800&display=swap"]),
    "sourceSerif": ("LMC Source Serif", ["https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,opsz,wght@0,8..60,200..900;1,8..60,200..900&display=swap"]),
    "sarasa": ("LMC Sarasa Mono", [f"https://fontsapi.zeoseven.com/159/{style}/result.css" for style in ("main", "sc-semi-bold", "sc-italic", "sc-semi-bold-italic")]),
    "jetbrains": ("LMC JetBrains Mono", ["https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,100..800;1,100..800&display=swap"]),
}
LICENSES = {
    "MiSans-license.pdf": "https://hyperos.mi.com/font-download/MiSans%E5%AD%97%E4%BD%93%E7%9F%A5%E8%AF%86%E4%BA%A7%E6%9D%83%E8%AE%B8%E5%8F%AF%E5%8D%8F%E8%AE%AE.pdf",
    "WenKai-OFL.txt": "https://raw.githubusercontent.com/lxgw/LxgwWenKai/main/OFL.txt",
    "Newsreader-OFL.txt": "https://raw.githubusercontent.com/productiontype/Newsreader/master/OFL.txt",
    "SourceSerif-OFL.txt": "https://raw.githubusercontent.com/adobe-fonts/source-serif/release/LICENSE.md",
    "Sarasa-OFL.txt": "https://raw.githubusercontent.com/be5invis/Sarasa-Gothic/main/LICENSE",
    "JetBrainsMono-OFL.txt": "https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/OFL.txt",
}


def fetch(url):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=40) as response:
                data = response.read()
                if not data:
                    raise ValueError(f"Empty response: {url}")
                return data
        except Exception:
            if attempt == 2:
                raise


def record(path, url, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {"file": str(path.relative_to(OUT)), "url": url, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def main():
    OUT.mkdir(parents=True, exist_ok=False)
    assets = []
    sheets = []
    for key, (family, urls) in SOURCES.items():
        chunks = []
        downloads = {}
        for url in urls:
            original = fetch(url)
            css = original.decode("utf-8")
            sheets.append(record(OUT / "upstream" / f"{key}-{len(chunks)}.css", url, original))
            rules = re.findall(r"@font-face\s*\{([^}]+)\}", css)
            if not rules:
                raise ValueError(f"No font faces: {url}")
            # Retain upstream copyright/version comments, not executable CSS.
            comments = "\n".join(re.findall(r"/\*[\s\S]*?\*/", css))
            chunks.append(comments)
            for rule in rules:
                source = re.search(r"url\([\"']?([^\"')]+\.woff2)[\"']?\)", rule)
                if not source:
                    raise ValueError(f"No WOFF2: {url}")
                remote = urllib.parse.urljoin(url, source[1])
                filename = f"{key}/{hashlib.sha256(remote.encode()).hexdigest()[:20]}.woff2"
                downloads[remote] = filename
                rule = re.sub(r"font-family\s*:[^;]+;", f'font-family:"{family}";', rule)
                rule = re.sub(r"src\s*:[^;]+;", f'src:url("./{filename}") format("woff2");', rule)
                chunks.append("@font-face{" + rule + "}")
        def download(item):
            url, filename = item
            data = fetch(url)
            if data[:4] != b"wOF2":
                raise ValueError(f"Not a WOFF2 font: {url}")
            return record(OUT / filename, url, data)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            files = list(pool.map(download, downloads.items()))
        assets.extend(files)
        (OUT / f"{key}.css").write_text("\n".join(chunks) + "\n")
        print(key, len(files), "files", sum(f["bytes"] for f in files), "bytes", flush=True)
    for name, url in LICENSES.items():
        assets.append(record(OUT / name, url, fetch(url)))
    (OUT / "sources.json").write_text(json.dumps({"stylesheets": sheets, "assets": sorted(assets, key=lambda x: x["file"])}, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
