"""Pure bounded Office document cells; all durable delivery belongs to CommitService.

The stored ooxml-spec-v1 recipe regenerates deterministic, uncompressed OOXML.
This deliberately supports text reports, typed data tables and text slides only.
No filesystem, provider, process, formulas, macros, templates or external parts.
Package structure follows Microsoft's public WordprocessingML, SpreadsheetML and
PresentationML documentation; no installed Office library is a runtime dependency.
"""
from __future__ import annotations

from copy import deepcopy
from decimal import Decimal
import hashlib
import io
import json
import math
import re
from xml.etree import ElementTree as ET
from zipfile import ZIP_STORED, ZipFile, ZipInfo

from .repository_context import SECRET_CONTENT, SENSITIVE_NAME
from .specialists import validate_schema

MAX_RECIPE_BYTES = 48 * 1024
MAX_ARTIFACT_BYTES = 1024 * 1024
MAX_CELLS = 2000
ENCODING = "ooxml-spec-v1"
MEDIA_TYPES = {
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}
_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
_CT = "http://schemas.openxmlformats.org/package/2006/content-types"
_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
_XML_BAD = re.compile(r"[\x00-\x08\x0b-\x1f\x7f\ud800-\udfff\ufffe\uffff]")
_RESERVED = re.compile(r"^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)", re.I)
_NAME_BAD = re.compile(r'[\x00-\x1f\x7f/\\:*?"<>|]')


def _object(properties, required=None):
    return {"type": "object", "properties": properties,
            "required": list(properties) if required is None else required, "additionalProperties": False}


def _array(items, maximum, minimum=0):
    return {"type": "array", "items": items, "minItems": minimum, "maxItems": maximum}


def _string(maximum, minimum=0):
    return {"type": "string", "minLength": minimum, "maxLength": maximum}


_SCALAR = {"type": ["string", "number", "boolean", "null"], "maxLength": 2000,
           "minimum": -1_000_000_000_000, "maximum": 1_000_000_000_000}
_BODIES = {
    "sections": _array(_object({"heading": _string(160), "paragraphs": _array(_string(4000), 10, 1)}), 20, 1),
    "sheets": _array(_object({"name": _string(31, 1), "columns": _array(_string(120, 1), 20, 1),
                              "rows": _array(_array(_SCALAR, 20, 1), 200)}), 8, 1),
    "slides": _array(_object({"title": _string(120, 1), "bullets": _array(_string(180, 1), 6)}), 12, 1),
}
_BODY_KEY = {"docx": "sections", "xlsx": "sheets", "pptx": "slides"}
_INPUT = _object({"name": _string(120, 1), "format": {"type": "string", "enum": list(MEDIA_TYPES)},
                  "title": _string(160, 1), **_BODIES}, ["name", "format", "title"])
# Publish the format exclusivity to planners. The shipped schema validator uses
# a bounded subset; _recipe also enforces these exact key sets independently.
_INPUT["oneOf"] = [{"properties": {"format": {"enum": [fmt]}}, "required": [key],
                     "not": {"anyOf": [{"required": [other]} for other in _BODIES if other != key]}}
                    for fmt, key in _BODY_KEY.items()]
_PROPOSAL = _object({"kind": {"type": "string", "enum": ["artifact"]}, "name": _string(120, 1),
                     "media_type": {"type": "string", "enum": list(MEDIA_TYPES.values())},
                     "encoding": {"type": "string", "enum": [ENCODING]}, "content": _string(MAX_RECIPE_BYTES, 1),
                     "sha256": _string(64, 64), "bytes": {"type": "integer", "minimum": 1, "maximum": MAX_ARTIFACT_BYTES},
                     "preview_text": _string(4000), "preview_truncated": {"type": "boolean"}})


def catalog() -> list[dict]:
    """Discovery only. The host wraps this payload in its Work tool receipt."""
    return [{"name": "create_document", "description":
             "Prepare a DOCX report (sections), XLSX workbook (sheets), or PPTX deck (slides). "
             "Supply exactly the matching format body. Text only: no formulas, links, images or macros. "
             "DOCX includes the document title; PPTX slides are exactly the supplied slides and title is document metadata. "
             "Returns an uncommitted recipe; export requires the operator's existing delivery action.",
             "input_schema": deepcopy(_INPUT), "output_schema": _object({"proposal": deepcopy(_PROPOSAL)}),
             "permissions": [], "runtime": {"language": "python", "dependencies": [], "network": False, "subprocess": False},
             "rollback": {"behavior": "no_durable_mutation"},
             "limits": {"recipe_bytes": MAX_RECIPE_BYTES, "artifact_bytes": MAX_ARTIFACT_BYTES,
                        "total_spreadsheet_cells": MAX_CELLS, "preview_chars": 4000}}]


def _json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _text(value, *, single_line=False):
    if _XML_BAD.search(value) or "\t" in value or (single_line and "\n" in value):
        raise ValueError("Document text contains unsupported control characters or line breaks")
    if SECRET_CONTENT.search(value):
        raise ValueError("Potential secret content is not admitted in document recipes")


def artifact_name(name: str, format: str) -> str:
    """Plain safe leaf names only; no path expansion or filesystem checks."""
    if (not isinstance(name, str) or not 1 <= len(name) <= 120 or _NAME_BAD.search(name)
            or name.startswith((".", " ")) or name.endswith((".", " ")) or _RESERVED.match(name)
            or SENSITIVE_NAME.search(name) or format not in MEDIA_TYPES or not name.endswith("." + format)):
        raise ValueError("Document requires a safe plain filename with the exact matching Office extension")
    _text(name, single_line=True)
    return name


def _recipe(arguments: dict) -> tuple[dict, str]:
    validate_schema(arguments, _INPUT)
    fmt = arguments["format"]
    if set(arguments) != {"name", "format", "title", _BODY_KEY[fmt]}:
        raise ValueError("Provide exactly the body matching the document format")
    artifact_name(arguments["name"], fmt)
    if not arguments["title"].strip():
        raise ValueError("Document title must contain visible text")
    pending = [arguments]
    while pending:
        value = pending.pop()
        if isinstance(value, str):
            _text(value)
        elif isinstance(value, (dict, list)):
            pending.extend(value.values() if isinstance(value, dict) else value)
    _text(arguments["title"], single_line=True)
    if fmt == "docx":
        for section in arguments["sections"]:
            _text(section["heading"], single_line=True)
    elif fmt == "xlsx":
        names, cells = set(), 0
        for sheet in arguments["sheets"]:
            name = sheet["name"]
            if (not name.strip() or re.search(r"[\[\]:*?/\\\n]", name) or name.startswith("'") or name.endswith("'")
                    or name.casefold() in names or name.casefold() == "history"):
                raise ValueError("Worksheet names must be unique valid Excel names")
            names.add(name.casefold())
            columns = sheet["columns"]
            if len({value.casefold() for value in columns}) != len(columns) or any(not value.strip() for value in columns):
                raise ValueError("Worksheet columns must have distinct visible labels")
            for value in columns:
                _text(value, single_line=True)
            cells += len(columns) * (1 + len(sheet["rows"]))
            if cells > MAX_CELLS:
                raise ValueError("Workbook exceeds the 2000-cell budget including headers")
            for row in sheet["rows"]:
                if len(row) != len(columns):
                    raise ValueError("Every worksheet row must match its column count")
                for value in row:
                    if isinstance(value, (float, int)) and not isinstance(value, bool):
                        if value and abs(value) < 1e-300:
                            raise ValueError("Spreadsheet numbers below the supported magnitude must be supplied as text")
                        digits = Decimal(str(value)).normalize().as_tuple().digits
                        if len(digits) > 15:
                            raise ValueError("Spreadsheet numbers are limited to 15 significant decimal digits; use text for exact identifiers")
    else:
        for slide in arguments["slides"]:
            if not slide["title"].strip() or any(not value.strip() for value in slide["bullets"]):
                raise ValueError("Slide titles and bullets must contain visible text")
            for value in [slide["title"], *slide["bullets"]]:
                _text(value, single_line=True)
    content = _json(arguments)
    if len(content.encode("utf-8")) > MAX_RECIPE_BYTES:
        raise ValueError("Document recipe exceeds the 48 KiB byte budget")
    return deepcopy(arguments), content


def _node(parent, tag, attributes=None, text=None):
    result = ET.SubElement(parent, tag, attributes or {})
    if text is not None:
        result.text = str(text)
    return result


def _xml(root):
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def _rels(entries):
    root = ET.Element("Relationships", {"xmlns": _PKG})
    for identifier, kind, target in entries:
        _node(root, "Relationship", {"Id": identifier, "Type": kind if kind.startswith("http") else _REL + "/" + kind, "Target": target})
    return _xml(root)


def _package(title, main, main_type, parts, types):
    content_types = ET.Element("Types", {"xmlns": _CT})
    _node(content_types, "Default", {"Extension": "rels", "ContentType": "application/vnd.openxmlformats-package.relationships+xml"})
    _node(content_types, "Default", {"Extension": "xml", "ContentType": "application/xml"})
    for name, kind in sorted({main: main_type, **types,
                              "docProps/core.xml": "application/vnd.openxmlformats-package.core-properties+xml",
                              "docProps/app.xml": "application/vnd.openxmlformats-officedocument.extended-properties+xml"}.items()):
        _node(content_types, "Override", {"PartName": "/" + name, "ContentType": kind})
    core = ET.Element("cp:coreProperties", {"xmlns:cp": "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
                "xmlns:dc": "http://purl.org/dc/elements/1.1/", "xmlns:dcterms": "http://purl.org/dc/terms/",
                "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance"})
    _node(core, "dc:title", text=title)
    _node(core, "dc:creator", text="YUR Desktop")
    _node(core, "cp:lastModifiedBy", text="YUR Desktop")
    for key in ("created", "modified"):
        _node(core, "dcterms:" + key, {"xsi:type": "dcterms:W3CDTF"}, "2000-01-01T00:00:00Z")
    app = ET.Element("Properties", {"xmlns": "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"})
    _node(app, "Application", text="YUR Desktop")
    _node(app, "AppVersion", text="1.0000")
    parts = {**parts, "[Content_Types].xml": _xml(content_types), "docProps/core.xml": _xml(core), "docProps/app.xml": _xml(app),
             "_rels/.rels": _rels([("rId1", "officeDocument", main),
                    ("rId2", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "docProps/core.xml"),
                    ("rId3", "extended-properties", "docProps/app.xml")])}
    if sum(len(value) for value in parts.values()) > MAX_ARTIFACT_BYTES:
        raise ValueError("Generated document exceeds the 1 MiB artifact budget")
    buffer = io.BytesIO()
    with ZipFile(buffer, "w", compression=ZIP_STORED, allowZip64=False) as archive:
        for name, raw in sorted(parts.items()):
            info = ZipInfo(name, date_time=(2000, 1, 1, 0, 0, 0))
            info.create_system = 0
            info.external_attr = 0o600 << 16
            info.compress_type = ZIP_STORED
            archive.writestr(info, raw)
    result = buffer.getvalue()
    if len(result) > MAX_ARTIFACT_BYTES:
        raise ValueError("Generated document exceeds the 1 MiB artifact budget")
    return result


def _docx(recipe):
    document = ET.Element("w:document", {"xmlns:w": _W})
    body = _node(document, "w:body")

    def paragraph(text, style):
        for line in text.split("\n"):
            p = _node(body, "w:p")
            _node(_node(p, "w:pPr"), "w:pStyle", {"w:val": style})
            _node(_node(p, "w:r"), "w:t", {"xml:space": "preserve"}, line)

    paragraph(recipe["title"], "Title")
    for section in recipe["sections"]:
        if section["heading"]:
            paragraph(section["heading"], "Heading1")
        for text in section["paragraphs"]:
            paragraph(text, "Normal")
    section = _node(body, "w:sectPr")
    _node(section, "w:pgSz", {"w:w": "12240", "w:h": "15840"})
    _node(section, "w:pgMar", {"w:top": "1080", "w:right": "1080", "w:bottom": "1080", "w:left": "1080",
                                "w:header": "720", "w:footer": "720", "w:gutter": "0"})
    styles = ET.Element("w:styles", {"xmlns:w": _W})
    for identifier, size, color in [("Normal", "22", "243247"), ("Title", "44", "123B58"), ("Heading1", "30", "123B58")]:
        style = _node(styles, "w:style", {"w:type": "paragraph", "w:styleId": identifier, **({"w:default": "1"} if identifier == "Normal" else {})})
        _node(style, "w:name", {"w:val": identifier})
        if identifier != "Normal":
            _node(style, "w:basedOn", {"w:val": "Normal"})
            _node(style, "w:next", {"w:val": "Normal"})
        ppr = _node(style, "w:pPr")
        _node(ppr, "w:spacing", {"w:after": "160", "w:line": "276", "w:lineRule": "auto"})
        if identifier != "Normal":
            _node(ppr, "w:keepNext")
        if identifier == "Heading1":
            _node(ppr, "w:outlineLvl", {"w:val": "0"})
        rpr = _node(style, "w:rPr")
        _node(rpr, "w:rFonts", {"w:ascii": "Calibri", "w:hAnsi": "Calibri"})
        _node(rpr, "w:color", {"w:val": color})
        _node(rpr, "w:sz", {"w:val": size})
        if identifier != "Normal":
            _node(rpr, "w:b")
    return _package(recipe["title"], "word/document.xml", MEDIA_TYPES["docx"] + ".main+xml",
                    {"word/document.xml": _xml(document), "word/styles.xml": _xml(styles),
                     "word/_rels/document.xml.rels": _rels([("rId1", "styles", "styles.xml")])},
                    {"word/styles.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"})


def _xlsx(recipe):
    workbook = ET.Element("workbook", {"xmlns": _S, "xmlns:r": _REL})
    sheets = _node(workbook, "sheets")
    parts, types, relationships = {}, {}, []
    for index, sheet in enumerate(recipe["sheets"], 1):
        _node(sheets, "sheet", {"name": sheet["name"], "sheetId": str(index), "r:id": f"rId{index}"})
        relative = f"worksheets/sheet{index}.xml"
        relationships.append((f"rId{index}", "worksheet", relative))
        document = ET.Element("worksheet", {"xmlns": _S})
        width = len(sheet["columns"])
        bottom_right = chr(64 + width) + str(len(sheet["rows"]) + 1)
        _node(document, "dimension", {"ref": "A1:" + bottom_right})
        views = _node(document, "sheetViews")
        view = _node(views, "sheetView", {"workbookViewId": "0"})
        _node(view, "pane", {"ySplit": "1", "topLeftCell": "A2", "activePane": "bottomLeft", "state": "frozen"})
        _node(document, "sheetFormatPr", {"defaultRowHeight": "15"})
        _node(_node(document, "cols"), "col", {"min": "1", "max": str(width), "width": "22", "customWidth": "1"})
        data = _node(document, "sheetData")
        for row_index, row in enumerate([sheet["columns"], *sheet["rows"]], 1):
            row_element = _node(data, "row", {"r": str(row_index)})
            for column_index, value in enumerate(row, 1):
                attrs = {"r": chr(64 + column_index) + str(row_index), "s": "1" if row_index == 1 else "0"}
                cell = _node(row_element, "c", attrs)
                if isinstance(value, str):
                    cell.set("t", "inlineStr")
                    _node(_node(cell, "is"), "t", {"xml:space": "preserve"}, value)
                elif isinstance(value, bool):
                    cell.set("t", "b")
                    _node(cell, "v", text="1" if value else "0")
                elif value is not None:
                    _node(cell, "v", text=str(value))
        _node(document, "autoFilter", {"ref": "A1:" + bottom_right})
        name = "xl/" + relative
        parts[name] = _xml(document)
        types[name] = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
    styles = ET.Element("styleSheet", {"xmlns": _S})
    fonts = _node(styles, "fonts", {"count": "2"})
    for bold in (False, True):
        font = _node(fonts, "font")
        if bold:
            _node(font, "b")
        _node(font, "sz", {"val": "11"})
        _node(font, "color", {"rgb": "FF123B58"})
        _node(font, "name", {"val": "Calibri"})
    fills = _node(styles, "fills", {"count": "2"})
    for pattern in ("none", "gray125"):
        _node(_node(fills, "fill"), "patternFill", {"patternType": pattern})
    border = _node(_node(styles, "borders", {"count": "1"}), "border")
    for side in ("left", "right", "top", "bottom", "diagonal"):
        _node(border, side)
    _node(_node(styles, "cellStyleXfs", {"count": "1"}), "xf", {"numFmtId": "0", "fontId": "0", "fillId": "0", "borderId": "0"})
    xfs = _node(styles, "cellXfs", {"count": "2"})
    for index in range(2):
        _node(xfs, "xf", {"numFmtId": "0", "fontId": str(index), "fillId": "0", "borderId": "0", "xfId": "0", "applyFont": "1"})
    _node(_node(styles, "cellStyles", {"count": "1"}), "cellStyle", {"name": "Normal", "xfId": "0", "builtinId": "0"})
    relationships.append((f"rId{len(relationships) + 1}", "styles", "styles.xml"))
    parts.update({"xl/workbook.xml": _xml(workbook), "xl/_rels/workbook.xml.rels": _rels(relationships), "xl/styles.xml": _xml(styles)})
    types["xl/styles.xml"] = "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"
    return _package(recipe["title"], "xl/workbook.xml", MEDIA_TYPES["xlsx"] + ".main+xml", parts, types)


def _shape_tree(parent):
    tree = _node(parent, "p:spTree")
    nonvisual = _node(tree, "p:nvGrpSpPr")
    _node(nonvisual, "p:cNvPr", {"id": "1", "name": ""})
    _node(nonvisual, "p:cNvGrpSpPr")
    _node(nonvisual, "p:nvPr")
    transform = _node(_node(tree, "p:grpSpPr"), "a:xfrm")
    for tag, attrs in [("off", {"x": "0", "y": "0"}), ("ext", {"cx": "0", "cy": "0"}),
                       ("chOff", {"x": "0", "y": "0"}), ("chExt", {"cx": "0", "cy": "0"})]:
        _node(transform, "a:" + tag, attrs)
    return tree


def _text_box(tree, identifier, name, y, height, lines, size, bullet=False):
    # Conservative full-width-character budget. Long bounded text gets a smaller
    # explicit font; actual native typography still depends on installed fonts.
    width_points = 10728960 / 12700 - 15 - (18 if bullet else 0)
    available_height = height / 12700 - 15
    while size > 1000 and sum(max(1, math.ceil(len(text) * size / 100 / width_points)) * size / 100 * 1.25 + 10
                              for text in lines or [""]) > available_height:
        size -= 100
    shape = _node(tree, "p:sp")
    nonvisual = _node(shape, "p:nvSpPr")
    _node(nonvisual, "p:cNvPr", {"id": str(identifier), "name": name})
    _node(nonvisual, "p:cNvSpPr", {"txBox": "1"})
    nvpr = _node(nonvisual, "p:nvPr")
    if name == "Title":
        _node(nvpr, "p:ph", {"type": "title"})
    props = _node(shape, "p:spPr")
    transform = _node(props, "a:xfrm")
    _node(transform, "a:off", {"x": "731520", "y": str(y)})
    _node(transform, "a:ext", {"cx": "10728960", "cy": str(height)})
    _node(_node(props, "a:prstGeom", {"prst": "rect"}), "a:avLst")
    _node(props, "a:noFill")
    _node(_node(props, "a:ln"), "a:noFill")
    body = _node(shape, "p:txBody")
    _node(_node(body, "a:bodyPr", {"wrap": "square", "anchor": "t"}), "a:noAutofit")
    _node(body, "a:lstStyle")
    for text in lines or [""]:
        paragraph = _node(body, "a:p")
        ppr = _node(paragraph, "a:pPr", {"marL": "228600" if bullet else "0", "indent": "-228600" if bullet else "0"})
        _node(_node(ppr, "a:lnSpc"), "a:spcPct", {"val": "125000"})
        _node(_node(ppr, "a:spcAft"), "a:spcPts", {"val": "1000"})
        _node(ppr, "a:buChar", {"char": "•"}) if bullet else _node(ppr, "a:buNone")
        run = _node(paragraph, "a:r")
        rpr = _node(run, "a:rPr", {"lang": "en-US", "sz": str(size), "b": "0" if bullet else "1"})
        _node(_node(rpr, "a:solidFill"), "a:srgbClr", {"val": "243247" if bullet else "123B58"})
        _node(rpr, "a:latin", {"typeface": "Calibri"})
        _node(run, "a:t", text=text)
        _node(paragraph, "a:endParaRPr", {"lang": "en-US", "sz": str(size)})


def _theme():
    theme = ET.Element("a:theme", {"xmlns:a": _A, "name": "YUR"})
    elements = _node(theme, "a:themeElements")
    colors = _node(elements, "a:clrScheme", {"name": "YUR"})
    for key, value in zip(("dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"),
                          ("243247", "FFFFFF", "123B58", "F3F6F9", "126E82", "287D6E", "5573A4", "AE7840", "795E96", "5C727D", "126E82", "795E96")):
        _node(_node(colors, "a:" + key), "a:srgbClr", {"val": value})
    fonts = _node(elements, "a:fontScheme", {"name": "YUR"})
    for kind in ("majorFont", "minorFont"):
        font = _node(fonts, "a:" + kind)
        for name, value in (("latin", "Calibri"), ("ea", ""), ("cs", "")):
            _node(font, "a:" + name, {"typeface": value})
    fmt = _node(elements, "a:fmtScheme", {"name": "YUR"})
    fill_list = _node(fmt, "a:fillStyleLst")
    for _ in range(3):
        _node(_node(fill_list, "a:solidFill"), "a:schemeClr", {"val": "phClr"})
    line_list = _node(fmt, "a:lnStyleLst")
    for width in (9525, 25400, 38100):
        line = _node(line_list, "a:ln", {"w": str(width), "cap": "flat", "cmpd": "sng", "algn": "ctr"})
        _node(_node(line, "a:solidFill"), "a:schemeClr", {"val": "phClr"})
        _node(line, "a:prstDash", {"val": "solid"})
        _node(line, "a:miter", {"lim": "800000"})
    effects = _node(fmt, "a:effectStyleLst")
    for _ in range(3):
        _node(_node(effects, "a:effectStyle"), "a:effectLst")
    backgrounds = _node(fmt, "a:bgFillStyleLst")
    for _ in range(3):
        _node(_node(backgrounds, "a:solidFill"), "a:schemeClr", {"val": "phClr"})
    return _xml(theme)


def _pptx(recipe):
    namespaces = {"xmlns:p": _P, "xmlns:a": _A, "xmlns:r": _REL}
    presentation = ET.Element("p:presentation", namespaces)
    _node(_node(presentation, "p:sldMasterIdLst"), "p:sldMasterId", {"id": "2147483648", "r:id": "rId1"})
    slides = _node(presentation, "p:sldIdLst")
    relationships = [("rId1", "slideMaster", "slideMasters/slideMaster1.xml")]
    parts, types = {}, {}
    for index, slide in enumerate(recipe["slides"], 1):
        _node(slides, "p:sldId", {"id": str(255 + index), "r:id": f"rId{index + 1}"})
        relationships.append((f"rId{index + 1}", "slide", f"slides/slide{index}.xml"))
        document = ET.Element("p:sld", namespaces)
        common = _node(document, "p:cSld", {"name": slide["title"]})
        tree = _shape_tree(common)
        _text_box(tree, 2, "Title", 457200, 1097280, [slide["title"]], 2800)
        _text_box(tree, 3, "Content", 1691640, 4572000, slide["bullets"], 2000, True)
        _node(_node(document, "p:clrMapOvr"), "a:masterClrMapping")
        path = f"ppt/slides/slide{index}.xml"
        parts[path] = _xml(document)
        parts[f"ppt/slides/_rels/slide{index}.xml.rels"] = _rels([("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml")])
        types[path] = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"
    _node(presentation, "p:sldSz", {"cx": "12192000", "cy": "6858000", "type": "screen16x9"})
    _node(presentation, "p:notesSz", {"cx": "6858000", "cy": "9144000"})
    master = ET.Element("p:sldMaster", namespaces)
    _shape_tree(_node(master, "p:cSld", {"name": "YUR"}))
    _node(master, "p:clrMap", {"bg1": "lt1", "tx1": "dk1", "bg2": "lt2", "tx2": "dk2",
          **{f"accent{i}": f"accent{i}" for i in range(1, 7)}, "hlink": "hlink", "folHlink": "folHlink"})
    _node(_node(master, "p:sldLayoutIdLst"), "p:sldLayoutId", {"id": "2147483649", "r:id": "rId1"})
    styles = _node(master, "p:txStyles")
    for kind in ("titleStyle", "bodyStyle", "otherStyle"):
        _node(styles, "p:" + kind)
    layout = ET.Element("p:sldLayout", {**namespaces, "type": "blank", "preserve": "1"})
    _shape_tree(_node(layout, "p:cSld", {"name": "Blank"}))
    _node(_node(layout, "p:clrMapOvr"), "a:masterClrMapping")
    parts.update({"ppt/presentation.xml": _xml(presentation), "ppt/_rels/presentation.xml.rels": _rels(relationships),
                  "ppt/slideMasters/slideMaster1.xml": _xml(master), "ppt/slideLayouts/slideLayout1.xml": _xml(layout),
                  "ppt/slideMasters/_rels/slideMaster1.xml.rels": _rels([("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"), ("rId2", "theme", "../theme/theme1.xml")]),
                  "ppt/slideLayouts/_rels/slideLayout1.xml.rels": _rels([("rId1", "slideMaster", "../slideMasters/slideMaster1.xml")]),
                  "ppt/theme/theme1.xml": _theme()})
    types.update({"ppt/slideMasters/slideMaster1.xml": "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
                  "ppt/slideLayouts/slideLayout1.xml": "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
                  "ppt/theme/theme1.xml": "application/vnd.openxmlformats-officedocument.theme+xml"})
    return _package(recipe["title"], "ppt/presentation.xml", MEDIA_TYPES["pptx"] + ".main+xml", parts, types)


def _render(recipe):
    return {"docx": _docx, "xlsx": _xlsx, "pptx": _pptx}[recipe["format"]](recipe)


def _preview(recipe):
    lines = [recipe["title"]]
    if recipe["format"] == "docx":
        for section in recipe["sections"]:
            lines.extend([section["heading"], *section["paragraphs"]])
    elif recipe["format"] == "xlsx":
        for sheet in recipe["sheets"]:
            lines.extend(["Sheet: " + sheet["name"], " | ".join(sheet["columns"])])
            for row in sheet["rows"]:
                lines.append(" | ".join("" if value is None else ("true" if value else "false") if isinstance(value, bool) else str(value) for value in row))
    else:
        for index, slide in enumerate(recipe["slides"], 1):
            lines.extend([f"Slide {index}: {slide['title']}", *slide["bullets"]])
    text = "\n".join(lines)
    return text[:4000], len(text) > 4000


def create_document(arguments: dict) -> dict:
    """Return only a validated proposal payload; no committed state or file write."""
    recipe, content = _recipe(arguments)
    raw = _render(recipe)
    preview, truncated = _preview(recipe)
    return {"proposal": {"kind": "artifact", "name": recipe["name"], "media_type": MEDIA_TYPES[recipe["format"]],
                         "content": content, "encoding": ENCODING, "sha256": hashlib.sha256(raw).hexdigest(),
                         "bytes": len(raw), "preview_text": preview, "preview_truncated": truncated}}


def artifact_bytes(proposal: dict) -> bytes:
    """Revalidate the whole recipe and actual byte identity at every delivery."""
    validate_schema(proposal, _PROPOSAL, "document proposal")
    content = proposal["content"]
    if len(content.encode("utf-8")) > MAX_RECIPE_BYTES:
        raise ValueError("Document recipe exceeds the 48 KiB byte budget")

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Document recipe contains duplicate JSON keys")
            result[key] = value
        return result

    try:
        arguments = json.loads(content, object_pairs_hook=pairs)
        recipe, canonical = _recipe(arguments)
    except (json.JSONDecodeError, RecursionError) as error:
        raise ValueError("Document recipe is malformed or too deeply nested") from error
    if canonical != content:
        raise ValueError("Document recipe must use its exact canonical JSON encoding")
    raw = _render(recipe)
    preview, truncated = _preview(recipe)
    expected = {"kind": "artifact", "name": recipe["name"], "media_type": MEDIA_TYPES[recipe["format"]],
                "content": canonical, "encoding": ENCODING, "sha256": hashlib.sha256(raw).hexdigest(),
                "bytes": len(raw), "preview_text": preview, "preview_truncated": truncated}
    if proposal != expected:
        raise ValueError("Document proposal differs from its regenerated bytes or metadata")
    return raw
