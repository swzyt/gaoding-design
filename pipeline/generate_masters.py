#!/usr/bin/env python3
"""Validate topic research, then submit complete agent-written master prompts unchanged."""
import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path

from PIL import Image
from workflow.jobs import run, download_resources


def media(tool, request, task_file, destination):
    if destination.exists():
        with Image.open(destination) as image:
            image.verify()
        return
    job_dir = destination.parent / 'master-job'
    job_dir.mkdir(exist_ok=True)
    if task_file.exists() and not (job_dir / 'job.json').exists():
        shutil.copyfile(task_file, job_dir / 'job.json')
    result = run(job_dir, tool, request)
    shutil.copyfile(job_dir / 'job.json', task_file)
    for resource in download_resources(job_dir, result):
        if resource['mimeType'].startswith('image/'):
            with Image.open(resource['file']) as image:
                image.verify()
            shutil.copyfile(resource['file'], destination)
            return
    raise RuntimeError('Completed master job has no image resource')


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def prepare(brief_path):
    brief = read_json(brief_path)
    root = brief_path.parent
    research = brief["research"]
    sources_path = root / research["sources"]
    analysis_path = root / research["analysis"]
    sources = read_json(sources_path)
    if len(sources) != 10 or not analysis_path.read_text(encoding="utf-8").strip():
        raise ValueError("10 inspected topic samples and a written analysis are required")
    evidence = {}
    for path in [brief_path, sources_path, analysis_path]:
        evidence[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
    for sample in sources:
        path = root / sample["file"]
        if not sample.get("src") or not path.is_file():
            raise ValueError("each research sample must retain its source and local image")
        evidence[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
    concepts = brief["concepts"]
    ids = set()
    requests = []
    for concept in concepts:
        key = concept["id"]
        if not re.fullmatch(r"[a-z0-9_-]+", key) or key in ids:
            raise ValueError("concept IDs must be unique safe directory names")
        ids.add(key)
        for field in ("concept", "reading_path", "zones", "depth_plan", "lighting_material", "copy", "layers", "master_prompt"):
            if not concept.get(field):
                raise ValueError(f"{key}: missing agent-authored {field}")
        if not isinstance(concept["master_prompt"], str) or not concept["master_prompt"].strip():
            raise ValueError(f"{key}: empty master prompt")
        requests.append((key, {
            "model": "Seedream-5-0-pro",
            "prompt": concept["master_prompt"],
            "width": str(concept.get("width", 1242)),
            "height": str(concept.get("height", 2208)),
            "resolution": concept.get("resolution", "2K"),
            "host_application": "codex",
        }))
    if not requests:
        raise ValueError("at least one agent-authored concept is required")
    return brief, evidence, requests


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("brief", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--check", action="store_true", help="validate research and requests without generation")
    args = parser.parse_args()
    brief, evidence, requests = prepare(args.brief.resolve())
    if args.check:
        print(f"Validated {len(requests)} concepts and 10 research samples; no generation")
        return
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    snapshot = {"brief": brief, "evidence_sha256": evidence}
    saved = out / "research-input.json"
    if saved.exists() and read_json(saved) != snapshot:
        parser.error("research or brief changed; use a new output directory")
    saved.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    for key, request in requests:
        directory = out / key
        directory.mkdir(exist_ok=True)
        request_path = directory / "master-request.json"
        if request_path.exists() and read_json(request_path) != request:
            parser.error("request changed; use a new output directory")
        request_path.write_text(json.dumps(request, ensure_ascii=False, indent=2), encoding="utf-8")
        media("image.generate", request, directory / "master.task", directory / "master.jpg")
        print(f"{key}: {directory / 'master.jpg'}", flush=True)


if __name__ == "__main__":
    main()
