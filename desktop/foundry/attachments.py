"""Explicit desktop file intake; extract data without executing document content."""
from __future__ import annotations

import base64
import hashlib
import io
import re
from pathlib import Path
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

from .repository_context import EXTENSIONS, SECRET_CONTENT, SENSITIVE_NAME
from .sources import read_checked

MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_TEXT_CHARS = 64_000
MAX_XML_BYTES = 4 * 1024 * 1024
MAX_ZIP_BYTES = 24 * 1024 * 1024
MAX_PAGES = 100
TEXT_EXTENSIONS = EXTENSIONS | {".csv", ".tsv", ".xml", ".sql", ".sh", ".ps1", ".ini", ".rtf"}
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}
# The original URL branch starts at every character in a long alphabetic run.
# Only the first such character can be needed for search success; anchoring it
# preserves the credential match language and avoids quadratic retries.
_ATTACHMENT_SECRET = re.compile(SECRET_CONTENT.pattern.replace("|[a-z]+://", "|(?<![a-z])[a-z]+://"), SECRET_CONTENT.flags)


def contains_credential_material(text: str) -> bool:
    return _ATTACHMENT_SECRET.search(text) is not None


def _xml(data: bytes):
    if len(data) > MAX_XML_BYTES or re.search(br"<!\s*(?:DOCTYPE|ENTITY)", data, re.I):
        raise ValueError("Document XML exceeds limits or declares external entities")
    return ElementTree.fromstring(data)


def _tag(node):
    return node.tag.rsplit("}", 1)[-1]


def _office(data: bytes, extension: str):
    parts = []
    with ZipFile(io.BytesIO(data)) as package:
        items = package.infolist()
        if len(items) > 2000 or sum(item.file_size for item in items) > MAX_ZIP_BYTES:
            raise ValueError("Document archive exceeds extraction limits")
        names = [item.filename for item in items]
        if len(names) != len(set(names)) or any(item.flag_bits & 1 for item in items):
            raise ValueError("Encrypted or ambiguous document archives are unsupported")
        if any("vbaproject" in name.lower() for name in names):
            raise ValueError("Macro-bearing documents are unsupported")
        if extension == ".docx":
            document = _xml(package.read("word/document.xml"))
            for paragraph in document.iter():
                if _tag(paragraph) == "p":
                    parts.append("".join(node.text or "" for node in paragraph.iter() if _tag(node) == "t"))
        elif extension == ".pptx":
            slides = sorted((name for name in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)),
                            key=lambda name: int(re.search(r"(\d+)\.xml$", name).group(1)))
            for name in slides[:MAX_PAGES]:
                slide = _xml(package.read(name))
                parts.append(f"[{name}]\n" + "\n".join(node.text or "" for node in slide.iter() if _tag(node) == "t"))
            return "\n\n".join(parts), {"slides": len(slides), "slides_read": min(len(slides), MAX_PAGES), "truncated": len(slides) > MAX_PAGES}
        elif extension == ".xlsx":
            shared = []
            if "xl/sharedStrings.xml" in names:
                shared = ["".join(node.text or "" for node in item.iter() if _tag(node) == "t")
                          for item in _xml(package.read("xl/sharedStrings.xml")) if _tag(item) == "si"]
            sheets = sorted(name for name in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name))
            for name in sheets[:MAX_PAGES]:
                parts.append(f"[{name}]")
                sheet = _xml(package.read(name))
                for row in sheet.iter():
                    if _tag(row) != "row":
                        continue
                    cells = []
                    for cell in row:
                        if _tag(cell) != "c":
                            continue
                        values = [node.text or "" for node in cell if _tag(node) == "v"]
                        value = values[0] if values else ""
                        if cell.get("t") == "s":
                            if not value.isdigit() or int(value) >= len(shared):
                                raise ValueError("Invalid spreadsheet shared-string reference")
                            value = shared[int(value)]
                        elif cell.get("t") == "inlineStr":
                            value = "".join(node.text or "" for node in cell.iter() if _tag(node) == "t")
                        formula = next((node.text for node in cell if _tag(node) == "f"), None)
                        cells.append(f"{cell.get('r', '?')}={value}" + (f" [formula: {formula}; cached value only]" if formula else ""))
                    parts.append("\t".join(cells))
            return "\n".join(parts), {"sheets": len(sheets), "sheets_read": min(len(sheets), MAX_PAGES), "truncated": len(sheets) > MAX_PAGES, "formulas_executed": False}
    return "\n".join(parts), {"paragraphs": len(parts), "truncated": False}


def _pdf(data: bytes):
    try:
        from pypdf import PdfReader
    except ImportError as error:
        raise ValueError("PDF reading requires the documented pypdf dependency") from error
    reader = PdfReader(io.BytesIO(data), strict=True)
    if reader.is_encrypted:
        raise ValueError("Encrypted PDFs must be unlocked before attaching")
    count = len(reader.pages)
    pages = []
    for index, page in enumerate(reader.pages[:MAX_PAGES]):
        content = page.extract_text() or ""
        pages.append(f"[Page {index + 1}]\n{content}")
        if sum(len(text) for text in pages) >= MAX_TEXT_CHARS:
            break
    extracted = "\n\n".join(pages)
    if not any(page.split("\n", 1)[1].strip() for page in pages):
        raise ValueError("This PDF has no extractable text. Attach page images to a vision-capable model for visual reading.")
    return extracted, {"pages": count, "pages_read": len(pages), "truncated": len(pages) < count, "ocr_performed": False}


def acquire_attachment(request: dict, *, text_only: bool = False) -> tuple[bytes, dict]:
    """Acquire once and parse those exact bytes; callers may commit the byte snapshot."""
    if not isinstance(request, dict) or set(request) - {"path", "expected_sha256"} or "path" not in request:
        raise ValueError("Attachment intake accepts only path and optional expected_sha256")
    value = request["path"]
    if not isinstance(value, str) or not value or len(value) > 4096 or "\0" in value:
        raise ValueError("Select an absolute local attachment path")
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts or path.name.startswith(".") or SENSITIVE_NAME.search(path.name):
        raise ValueError("Hidden, credential, relative or traversal attachment paths are excluded")
    extension = path.suffix.lower()
    if extension not in TEXT_EXTENSIONS | set(IMAGE_TYPES) | {".pdf", ".docx", ".xlsx", ".pptx"}:
        raise ValueError("Unsupported attachment type; use text, PDF, Office or a supported image")
    if text_only and extension in IMAGE_TYPES:
        raise ValueError("Project reference files support text, PDF and Office documents; images are unsupported")
    data = read_checked(path.parent, path.name, MAX_FILE_BYTES)
    digest = hashlib.sha256(data).hexdigest()
    expected = request.get("expected_sha256")
    if expected is not None and (not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected) or expected != digest):
        raise ValueError("The attachment changed; select it again before using new content")
    return data, extract_attachment_bytes(data, name=path.name, source_path=str(path.resolve()))


def read_attachment(request: dict) -> dict:
    return acquire_attachment(request)[1]


def extract_attachment_bytes(data: bytes, *, name: str, source_path: str) -> dict:
    """Parse a bounded acquired snapshot without opening or executing any source file."""
    if type(data) is not bytes or len(data) > MAX_FILE_BYTES:
        raise ValueError("Attachment bytes exceed the intake limit")
    if (not isinstance(name, str) or not name or len(name) > 255 or Path(name).name != name
            or name.startswith(".") or SENSITIVE_NAME.search(name)):
        raise ValueError("Unsupported attachment name")
    extension = Path(name).suffix.lower()
    if extension not in TEXT_EXTENSIONS | set(IMAGE_TYPES) | {".pdf", ".docx", ".xlsx", ".pptx"}:
        raise ValueError("Unsupported attachment type; use text, PDF, Office or a supported image")
    record = {"name": name, "path": source_path, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
              "provenance": {"operation": "attachment.read", "mode": "read-only", "code_executed": False}}
    if extension in IMAGE_TYPES:
        if len(data) > MAX_IMAGE_BYTES:
            raise ValueError("Image exceeds the 8 MiB limit")
        try:
            from PIL import Image
            with Image.open(io.BytesIO(data)) as picture:
                actual = Image.MIME.get(picture.format)
                if actual != IMAGE_TYPES[extension] or picture.width * picture.height > 40_000_000:
                    raise ValueError("Image type or pixel dimensions exceed the attachment contract")
                dimensions = {"width": picture.width, "height": picture.height}
                picture.verify()
        except ImportError as error:
            raise ValueError("Image validation requires the documented Pillow dependency") from error
        return {**record, "kind": "image", "mime": actual, **dimensions,
                "data_url": f"data:{actual};base64," + base64.b64encode(data).decode("ascii")}
    try:
        if extension in {".docx", ".xlsx", ".pptx"}:
            content, extraction = _office(data, extension)
        elif extension == ".pdf":
            content, extraction = _pdf(data)
        else:
            content, extraction = data.decode("utf-8-sig"), {"truncated": False}
            if "\0" in content:
                raise ValueError("Binary data is not a text attachment")
    except (BadZipFile, KeyError, ElementTree.ParseError, UnicodeDecodeError) as error:
        raise ValueError("The attachment is malformed or is not a supported text encoding") from error
    if contains_credential_material(content):
        raise ValueError("Attachment content includes credential-like material and is excluded")
    extraction["truncated"] = extraction.get("truncated", False) or len(content) > MAX_TEXT_CHARS
    return {**record, "kind": "text", "content": content[:MAX_TEXT_CHARS], "extraction": extraction}
