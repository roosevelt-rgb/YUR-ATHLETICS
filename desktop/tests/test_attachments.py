import base64
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

from foundry.attachments import read_attachment, acquire_attachment, extract_attachment_bytes, contains_credential_material
from foundry.repository_context import SECRET_CONTENT


class AttachmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def file(self, name, data):
        path = self.root / name
        path.write_bytes(data if isinstance(data, bytes) else data.encode())
        return path

    def archive(self, name, parts):
        content = io.BytesIO()
        with ZipFile(content, 'w') as bundle:
            for path, text in parts.items():
                bundle.writestr(path, text)
        return self.file(name, content.getvalue())

    def read(self, path, **fields):
        return read_attachment({'path': str(path), **fields})

    def test_text_identity_changed_hash_and_no_execution(self):
        path = self.file('example.py', "raise RuntimeError('Never execute attachment source')")
        result = self.read(path)
        self.assertEqual(result['content'], path.read_text())
        self.assertFalse(result['provenance']['code_executed'])
        self.assertEqual(self.read(path, expected_sha256=result['sha256']), result)
        path.write_text('changed')
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.read(path, expected_sha256=result['sha256'])

    def test_byte_parser_is_filesystem_independent_and_acquisition_returns_exact_snapshot(self):
        path = self.file('snapshot.txt', 'Snapshot evidence')
        payload, result = acquire_attachment({'path': str(path)})
        path.unlink()
        self.assertEqual(extract_attachment_bytes(payload, name=path.name, source_path=str(path)), result)
        self.assertEqual(payload, b'Snapshot evidence')
        with self.assertRaisesRegex(ValueError, 'images are unsupported'):
            acquire_attachment({'path': str(path.with_suffix('.png'))}, text_only=True)

    def test_credential_filter_preserves_url_patterns_and_bounds_long_alphabetic_lines(self):
        for value in ('https://user:password@example.test', 'ABCHTTPS://person:private@example.test',
                      'prefix_http://name:password@example.test', '1https://name:password@example.test',
                      'https://example.test/public', 'sk-' + 'A' * 48,
                      'Bearer ' + 'B' * 32, 'password="private-value"', 'ordinary project text'):
            self.assertEqual(contains_credential_material(value), SECRET_CONTENT.search(value) is not None)
        # Previously the unanchored scheme branch retried all 70k starting
        # offsets. This must complete within ordinary bounded test execution.
        result = self.read(self.file('long.txt', 'A' * 70000))
        self.assertEqual(len(result['content']), 64000)
        self.assertTrue(result['extraction']['truncated'])

    def test_docx_extracts_paragraphs_without_hyperlink_fetch(self):
        path = self.archive('brief.docx', {'word/document.xml': '<document><p><t>Project brief</t></p><p><t>Two phases</t></p></document>', 'word/_rels/document.xml.rels': '<Relationships><Relationship Target="https://example.invalid/private"/></Relationships>'})
        result = self.read(path)
        self.assertEqual(result['content'], 'Project brief\nTwo phases')
        self.assertEqual(result['extraction']['paragraphs'], 2)

    def test_spreadsheet_preserves_cells_and_labels_cached_formula(self):
        path = self.archive('takeoff.xlsx', {'xl/sharedStrings.xml': '<sst><si><t>Concrete</t></si></sst>', 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>125</v></c><c r="C1"><f>B1*2</f><v>250</v></c></row></sheetData></worksheet>'})
        result = self.read(path)
        self.assertIn('A1=Concrete\tB1=125\tC1=250 [formula: B1*2; cached value only]', result['content'])
        self.assertFalse(result['extraction']['formulas_executed'])

    def test_slides_use_numeric_order(self):
        path = self.archive('deck.pptx', {'ppt/slides/slide10.xml':'<slide><t>Ten</t></slide>', 'ppt/slides/slide2.xml':'<slide><t>Two</t></slide>'})
        result = self.read(path)
        self.assertLess(result['content'].index('Two'), result['content'].index('Ten'))
        self.assertEqual(result['extraction']['slides'], 2)

    def test_malformed_macro_and_entity_documents_rejected(self):
        paths = [self.file('bad.docx', b'not a ZIP'),
                 self.archive('macro.docx', {'word/document.xml':'<document/>', 'word/vbaProject.bin':'bad'}),
                 self.archive('entity.docx', {'word/document.xml':'<!DOCTYPE doc [<!ENTITY a SYSTEM "file:///etc/passwd">]><document>&a;</document>'})]
        for path in paths:
            with self.subTest(path=path.name), self.assertRaises(ValueError):
                self.read(path)

    def test_budget_and_secret_content_fail_closed(self):
        with self.assertRaises(ValueError):
            self.read(self.file('credentials.txt', 'do not read'))
        with self.assertRaises(ValueError):
            self.read(self.file('private.txt', '-----BEGIN PRIVATE KEY-----\nfixture'))
        with patch('foundry.attachments.MAX_FILE_BYTES', 5), self.assertRaises(ValueError):
            self.read(self.file('large.txt', 'longer than five bytes'))
        with patch('foundry.attachments.MAX_TEXT_CHARS', 4):
            result = self.read(self.file('normal.txt', 'bounded content'))
        self.assertEqual(result['content'], 'boun')
        self.assertTrue(result['extraction']['truncated'])

    def test_valid_image_decoded_identity_and_false_extension(self):
        from PIL import Image
        buffer = io.BytesIO()
        Image.new('RGB', (2, 3), '#128856').save(buffer, format='PNG')
        result = self.read(self.file('image.png', buffer.getvalue()))
        self.assertEqual((result['width'], result['height'], result['mime']), (2, 3, 'image/png'))
        self.assertEqual(base64.b64decode(result['data_url'].split(',', 1)[1]), buffer.getvalue())
        with self.assertRaises(ValueError):
            self.read(self.file('wrong.jpg', buffer.getvalue()))

    def test_pdf_text_pages_and_scanned_boundary(self):
        from pypdf import PdfWriter
        from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
        writer = PdfWriter()
        page = writer.add_blank_page(width=200, height=200)
        stream = DecodedStreamObject()
        stream.set_data(b'BT /F1 12 Tf 20 100 Td (Evidence 125 CY) Tj ET')
        font = DictionaryObject({NameObject('/Type'):NameObject('/Font'), NameObject('/Subtype'):NameObject('/Type1'), NameObject('/BaseFont'):NameObject('/Helvetica')})
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
        page[NameObject('/Contents')] = writer._add_object(stream)
        output = io.BytesIO(); writer.write(output)
        result = self.read(self.file('estimate.pdf', output.getvalue()))
        self.assertIn('Evidence 125 CY', result['content'])
        self.assertEqual(result['extraction']['pages_read'], 1)
        self.assertFalse(result['extraction']['ocr_performed'])
        blank = PdfWriter(); blank.add_blank_page(width=10, height=10)
        output = io.BytesIO(); blank.write(output)
        with self.assertRaisesRegex(ValueError, 'no extractable text'):
            self.read(self.file('scan.pdf', output.getvalue()))


if __name__ == '__main__':
    unittest.main()
