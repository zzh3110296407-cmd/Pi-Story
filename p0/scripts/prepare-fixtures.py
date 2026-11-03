"""Reproduce with bundled Python 3.12 -B p0/scripts/prepare-fixtures.py.

pyarrow 21.0.0 wheel lives in D:/开源/test/pi-Story/p0/python312-deps.
Only train prompts are read. No .env, credential or valid/test file is read.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path("D:/开源/test/pi-Story/p0")
sys.path.insert(0, str(ROOT / "python312-deps"))
import pyarrow.parquet as pq

destination = ROOT / "fixtures"
destination.mkdir(parents=True, exist_ok=True)

def save(name, value):
    text = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    secret = os.environ.get("DEEPSEEK_API_KEY")
    if (secret and secret in text) or re.search(r"sk-[A-Za-z0-9_-]{20,}", text):
        raise RuntimeError("Secret detected: fixture not saved")
    (destination / name).write_text(text, encoding="utf-8")

base = Path("D:/开源/test/story_dome_subject_cognition_20261022")
sources = [base / "offline/A/writing.json", base / "runs/2_A_1/writing.json", base / "runs/3_A_1/writing.json"]
manifest = []
books = []
for index, source in enumerate(sources, 1):
    raw = source.read_bytes()
    book = json.loads(raw.decode("utf-8-sig"))
    books.append(book)
    save(f"writing-{index}.json", book)
    manifest.append({"source": str(source), "copy": f"writing-{index}.json", "sha256": hashlib.sha256(raw).hexdigest()})
chapters = [{"chapterNo": chapter["chapter_no"], "text": chapter["text"], "sourcePath": str(sources[0])} for chapter in books[0]["chapters"][:3]]
assert len(chapters) == 3 and all(chapter["text"] for chapter in chapters)
save("chapters.json", chapters)
save("story-state.json", books[0]["current_data"])

prompt_source = Path("D:/AI/Story Dome/Dataset/ConStory-Bench/Dataset/train/prompts.parquet")
table = pq.read_table(prompt_source, columns=["id", "language", "task_type", "prompt"])
prompts = [row for row in table.to_pylist() if row["language"].lower() in ("english", "en")][:2]
if not prompts:
    prompts = table.slice(0, 2).to_pylist()
assert len(prompts) == 2
save("prompts.json", prompts)
save("fixture-sources.json", {"writing": manifest, "promptSource": str(prompt_source), "promptIds": [row["id"] for row in prompts], "pyarrow": "21.0.0", "python": sys.version.split()[0]})

paragraph = "雨停时，林遥在旧书店门口发现一把铜钥匙。钥匙的齿间夹着蓝色丝线，与父亲失踪那晚留下的布料相同。店主没有替她解释，只把一本缺页的航海日志推到灯下。林遥看见自己的名字写在二十年前的日期旁。她没有立刻翻到结尾，而是先在纸上记下当日见过的人和听到的话：亲眼所见、别人转述和自己的猜测，必须分开。街对面的钟响了三声，一位陌生人收起伞，朝书店走来。林遥把钥匙握在左手里，决定先问他为什么认识父亲。"
chinese = "# 第一章 雨后的钥匙\n\n" + "\n\n".join(f"第{i + 1}段：{paragraph}" for i in range(10))
assert 1800 <= len(chinese) <= 2600
(destination / "chinese-sample.md").write_text(chinese + "\n", encoding="utf-8")
print(json.dumps({"chapters": len(chapters), "prompts": len(prompts), "chineseCharacters": len(chinese), "directory": str(destination)}, ensure_ascii=False))
