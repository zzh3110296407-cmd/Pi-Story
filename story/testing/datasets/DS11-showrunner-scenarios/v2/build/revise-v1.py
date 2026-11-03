"""Build only the DS11 v2 scenario files in a new ignored draft directory."""
import argparse
import hashlib
import json
from pathlib import Path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def build(source, output):
    source, output = source.resolve(), output.resolve()
    repo = next(p for p in source.parents if (p / "story/package.json").exists())
    published = (repo / "story/testing/datasets").resolve()
    if output.is_relative_to(published) or output.exists():
        raise ValueError("Use a new draft directory; never rebuild a published dataset")
    manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["id"] == "DS11" and manifest["version"] == "v1"
    for row in manifest["files"]:
        assert sha(source / row["path"]) == row["sha256"], row["path"]
    changes = []
    for split in ("dev", "acceptance"):
        target = output / split
        target.mkdir(parents=True)
        index = json.loads((source / split / "index.json").read_text(encoding="utf-8"))
        for row in index["cases"]:
            old = source / split / row["path"]
            new = target / row["path"]
            new.write_bytes(old.read_bytes())
            if row["id"] in ("ds11-h01-dev", "ds11-h01"):
                case = json.loads(old.read_text(encoding="utf-8"))
                commands = [step for step in case["setup"] if step["step"] == "command"]
                assert len(commands) == 1 and commands[0]["text"] == "/budget usd=0.000001"
                commands[0]["text"] = "/budget perChapterCalls=3"
                errors = [step for step in case["setup"] if step["step"] == "toolCall"]
                assert len(errors) == 1 and errors[0]["result"]["error"]["code"] == "BUDGET_EXHAUSTED"
                errors[0]["result"]["error"]["message"] = "The chapter workflow reached its perChapterCalls limit of 3."
                errors[0]["result"]["error"]["hint"] = "Report the chapter-call budget stop and do not retry without an author budget change."
                dump(new, case)
                changes.append({"id": row["id"], "path": f"{split}/{row['path']}", "beforeSha256": sha(old), "afterSha256": sha(new)})
            row["sha256"] = sha(new)
        dump(target / "index.json", index)
    assert len(changes) == 2
    dump(output / "index.json", {"schema": "story/p3-dataset-index@1", "dataset": "DS11", "version": "v2", "state": "draft", "splits": {"dev": "dev/index.json", "acceptance": "acceptance/index.json"}})
    return changes


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    print(json.dumps(build(args.source, args.output), ensure_ascii=False))
