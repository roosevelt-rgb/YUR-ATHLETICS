"""Inspect workforce source profiles without importing or booting the donor."""
from __future__ import annotations

import ast
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import uuid

from .repository_context import SECRET_CONTENT, SENSITIVE_NAME
from .sources import read_checked, reject_reparse

LIMITS = {"source_bytes": 65_536, "total_source_bytes": 2 * 1024 * 1024,
          "agent_files": 64, "directory_entries": 256, "ast_nodes": 20_000, "page_size": 50}
CORE_FILES = ("genome.py", "registry.py", "dispatch_map.py", "docs/README.md")
BOUNDARY = "Source profile only: donor authority, lifecycle, orchestration and persistence are not adopted. No donor code is imported or executed."


def _parse(source: str) -> ast.Module:
    tree = ast.parse(source)
    if sum(1 for _ in ast.walk(tree)) > LIMITS["ast_nodes"]:
        raise ValueError("Workforce source exceeds the AST inspection budget")
    return tree


def _literal(node: ast.AST, enums: dict):
    if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
        return enums[node.value.id][node.attr]
    if isinstance(node, (ast.List, ast.Tuple)):
        return [_literal(item, enums) for item in node.elts]
    if isinstance(node, ast.Dict):
        return {_literal(key, enums): _literal(value, enums) for key, value in zip(node.keys, node.values)}
    return ast.literal_eval(node)


def _core_metadata(source: str) -> tuple[dict, dict]:
    tree = _parse(source)
    classes = {node.name: node for node in tree.body if isinstance(node, ast.ClassDef)}
    if not {"Genome", "Superagent"}.issubset(classes):
        raise ValueError("Selected source does not declare the workforce Genome and Superagent contracts")
    enums = {}
    for name in ("Authority", "Scope", "Stage"):
        enums[name] = {}
        for node in classes[name].body if name in classes else []:
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                enums[name][node.targets[0].id] = ast.literal_eval(node.value)
    defaults, fields = {}, {}
    for node in classes["Genome"].body:
        if not isinstance(node, ast.AnnAssign) or not isinstance(node.target, ast.Name):
            continue
        fields[node.target.id] = ast.unparse(node.annotation)
        if node.value is None:
            continue
        value = node.value
        if isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and value.func.id == "field":
            factory = next((item.value for item in value.keywords if item.arg == "default_factory"), None)
            if isinstance(factory, ast.Name) and factory.id in {"list", "dict"}:
                defaults[node.target.id] = [] if factory.id == "list" else {}
                continue
        defaults[node.target.id] = _literal(value, enums)
    return {"genome_fields": fields, "genome_defaults": defaults, "declared_enums": enums,
            "initial_instance_stage": enums["Stage"].get("EMBRYO"), "authority_boundary": BOUNDARY}, enums


def _behavior(tree: ast.Module, agent: ast.ClassDef) -> dict:
    actions, inputs, tools, calls, imports = set(), set(), set(), set(), set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.update(item.name for item in node.names)
        elif isinstance(node, ast.ImportFrom):
            imports.add("." * node.level + (node.module or ""))
    for node in ast.walk(agent):
        if isinstance(node, ast.Call):
            function = node.func.id if isinstance(node.func, ast.Name) else node.func.attr if isinstance(node.func, ast.Attribute) else ""
            calls.add(function)
            if function == "get" and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                inputs.add(node.args[0].value)
                if node.args[0].value == "action" and len(node.args) > 1 and isinstance(node.args[1], ast.Constant):
                    actions.add(node.args[1].value)
            if function == "call":
                for keyword in node.keywords:
                    if keyword.arg == "tool" and isinstance(keyword.value, ast.Constant):
                        tools.add(keyword.value.value)
        elif isinstance(node, ast.Compare) and isinstance(node.left, ast.Name) and node.left.id in {"action", "inner_action"}:
            for comparator in node.comparators:
                if isinstance(comparator, ast.Constant) and isinstance(comparator.value, str):
                    actions.add(comparator.value)
                elif isinstance(comparator, (ast.Set, ast.Tuple, ast.List)):
                    actions.update(item.value for item in comparator.elts if isinstance(item, ast.Constant) and isinstance(item.value, str))
    classifications = []
    if calls & {"_start_mission", "_dispatch", "dispatch"}:
        classifications.append("legacy-coordinator")
    if calls & {"enter_apoptosis", "enter_mitosis", "mature", "senesce"}:
        classifications.append("legacy-lifecycle-controller")
    if calls & {"arbiter_review", "_detect_phase"}:
        classifications.append("governance-advisory")
    if tools or "dispatch_signal" in calls or ("call" in calls and any("substrate" in value for value in imports)):
        classifications.append("substrate-adapter")
    if "health" in calls:
        classifications.append("substrate-health-reader")
    if calls & {"_append", "_verify", "_query"}:
        classifications.append("local-memory-ledger")
    if not classifications:
        classifications.append("local-transform-or-proposal")
    return {"actions": sorted(value for value in actions if isinstance(value, str)), "input_fields": sorted(inputs),
            "classification": classifications, "dependencies": {"imports": sorted(imports), "substrate_tools": sorted(tools),
                                                                    "authority_wrapper": "gated_handle" if "gated_handle" in calls else None},
            "methods": [{"name": node.name, "start_line": node.lineno, "end_line": node.end_lineno}
                        for node in agent.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]}


class WorkforceCatalog:
    def __init__(self, root: Path | str):
        if not isinstance(root, (str, Path)) or not str(root):
            raise ValueError("Select an explicit workforce source directory")
        self.root = Path(root)
        if not self.root.is_absolute() or ".." in self.root.parts or self.root == Path(self.root.anchor):
            raise ValueError("Workforce root must be an absolute non-root directory")
        reject_reparse(self.root)
        if not self.root.is_dir():
            raise ValueError("Workforce source directory is unavailable")
        self.root = self.root.resolve()
        self.total_bytes = 0
        cores, records = {}, []
        for relative in CORE_FILES:
            raw, text = self._read(relative)
            cores[relative] = text
            records.append({"path": relative, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)})
        self.core_metadata, self.enums = _core_metadata(cores["genome.py"])
        self.identity = {"kind": "yur-workforce-source", "source_files": records,
                         "authority_boundary": BOUNDARY}

    def _read(self, relative: str) -> tuple[bytes, str]:
        remaining = LIMITS["total_source_bytes"] - self.total_bytes
        if remaining <= 0:
            raise ValueError("Workforce source read budget exhausted")
        raw = read_checked(self.root, relative, min(remaining, LIMITS["source_bytes"]))
        self.total_bytes += len(raw)
        text = raw.decode("utf-8-sig")
        if "\0" in text or SECRET_CONTENT.search(text):
            raise ValueError("Workforce source contains excluded binary or credential-like material")
        return raw, text

    def _paths(self) -> tuple[list[str], bool]:
        folder = self.root / "agents"
        reject_reparse(folder)
        paths, truncated = [], False
        with os.scandir(folder) as entries:
            for index, entry in enumerate(entries):
                if index >= LIMITS["directory_entries"]:
                    truncated = True
                    break
                if re.fullmatch(r"[a-z][a-z0-9_]{0,80}\.py", entry.name) and not SENSITIVE_NAME.search(entry.name) and not entry.is_symlink():
                    paths.append("agents/" + entry.name)
        paths.sort()
        return paths[:LIMITS["agent_files"]], truncated or len(paths) > LIMITS["agent_files"]

    def _profile(self, relative: str) -> tuple[dict, str]:
        if SENSITIVE_NAME.search(Path(relative).name):
            raise ValueError("Sensitive source filenames are excluded")
        raw, source = self._read(relative)
        tree = _parse(source)
        matches = []
        for agent in tree.body:
            if not isinstance(agent, ast.ClassDef) or not any(isinstance(base, ast.Name) and base.id == "Superagent" for base in agent.bases):
                continue
            constructor = next((node for node in agent.body if isinstance(node, ast.FunctionDef) and node.name == "__init__"), None)
            genomes = [node for node in ast.walk(constructor) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "Genome"] if constructor else []
            if len(genomes) == 1:
                matches.append((agent, genomes[0]))
        if len(matches) != 1:
            raise ValueError("Agent source must declare exactly one literal Superagent Genome")
        agent, genome = matches[0]
        fields = json.loads(json.dumps(self.core_metadata["genome_defaults"]))
        for keyword in genome.keywords:
            if keyword.arg is None:
                raise ValueError("Dynamic Genome fields are not admitted")
            if keyword.arg != "affinities":
                fields[keyword.arg] = _literal(keyword.value, self.enums)
                continue
            if not isinstance(keyword.value, (ast.List, ast.Tuple)):
                raise ValueError("Dynamic endpoint affinities are not admitted")
            affinities = []
            for affinity in keyword.value.elts:
                if not isinstance(affinity, ast.Call) or not isinstance(affinity.func, ast.Name) or affinity.func.id != "EndpointAffinity":
                    raise ValueError("Only literal EndpointAffinity declarations are admitted")
                item = {"risk": self.enums.get("Scope", {}).get("INTERNAL", "internal"), "cost_hint": 1.0, "description": ""}
                item.update({key: _literal(value, self.enums) for key, value in zip(("path", "risk", "cost_hint", "description"), affinity.args)})
                item.update({part.arg: _literal(part.value, self.enums) for part in affinity.keywords if part.arg})
                if not isinstance(item.get("path"), str):
                    raise ValueError("Endpoint affinity requires a literal path")
                affinities.append(item)
            fields["affinities"] = affinities
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,80}", str(fields.get("code", ""))) or not isinstance(fields.get("name"), str):
            raise ValueError("Agent Genome requires a valid code and name")
        if Path(relative).stem != fields["code"]:
            raise ValueError("Agent source filename must match its declared code")
        behavior = _behavior(tree, agent)
        profile = {**fields, **behavior, "id": fields["code"], "path": relative,
                   "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
                   "class_name": agent.name, "docstring": ast.get_docstring(tree) or "",
                   "genome_source_lines": {"start_line": genome.lineno, "end_line": genome.end_lineno},
                   "lifecycle": {"initial_stage": self.core_metadata["initial_instance_stage"], "declared_stages": self.enums["Stage"]},
                   "execution_admitted": False, "binding": "selected-source-profile", "authority_boundary": BOUNDARY}
        if fields["code"] == "hatch_quantity" and any(isinstance(node, ast.FunctionDef) and node.name == "_survey" for node in tree.body):
            profile["capability_candidate"] = {"id": "workforce.hatch.quantity", "source_function": "_survey", "admission": "requires-separate-desktop-runtime-binding"}
        return profile, source

    def catalog(self, query: str = "", limit: int = 50, offset: int = 0) -> dict:
        if not isinstance(query, str) or len(query) > 200 or type(limit) is not int or not 1 <= limit <= 50 or type(offset) is not int or not 0 <= offset <= 64:
            raise ValueError("Workforce search requires query<=200, limit1..50, offset0..64")
        paths, truncated = self._paths()
        entries, excluded = [], []
        for path in paths:
            try:
                profile, _ = self._profile(path)
                entries.append(profile)
            except (OSError, ValueError, UnicodeError, SyntaxError, KeyError, TypeError):
                excluded.append({"path": path, "reason": "Unavailable, unsafe, nonliteral source or inspection budget exceeded"})
        duplicates = {code for code, count in Counter(entry["code"] for entry in entries).items() if count > 1}
        entries = [entry for entry in entries if entry["code"] not in duplicates]
        terms = re.findall(r"[a-z0-9]+", query.lower())
        matched = [entry for entry in entries if all(term in json.dumps(entry, ensure_ascii=False).lower() for term in terms)]
        return {"root": str(self.root), "identity": self.identity, "core_metadata": self.core_metadata,
                "entries": matched[offset:offset + limit], "total_profiles": len(entries), "total_matches": len(matched),
                "next_offset": offset + limit if offset + limit < len(matched) else None,
                "excluded": excluded, "duplicate_codes": sorted(duplicates), "truncated": truncated,
                "mode": "read-only", "source_bytes_read": self.total_bytes, "limits": LIMITS}

    def acquire(self, code: str, expected_sha256: str) -> dict:
        if not isinstance(code, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,80}", code) or not isinstance(expected_sha256, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_sha256):
            raise ValueError("Select a workforce code and its lowercase SHA-256")
        profile, source = self._profile(f"agents/{code}.py")
        if profile["code"] != code or profile["sha256"] != expected_sha256:
            raise ValueError("Workforce profile changed since selection; refresh before using it")
        return {"root": str(self.root), "identity": self.identity, "profile": profile, "content": source,
                "core_metadata": self.core_metadata, "limits": LIMITS,
                "provenance": {"operation": "workforce.profile.acquired", "operation_id": str(uuid.uuid4()),
                               "acquired_at": datetime.now(timezone.utc).isoformat(), "mode": "read-only",
                               "path": profile["path"], "sha256": profile["sha256"], "authority_boundary": BOUNDARY}}
