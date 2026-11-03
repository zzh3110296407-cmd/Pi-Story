"""Select only unseen valid prompts; never open ConStory's test split."""
import hashlib
import json
from pathlib import Path
import random
import re
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parent.parent
V1 = ROOT.parents[2] / 'datasets' / 'DS08-opening-prompts' / 'v1'
SOURCE = Path(r'D:\AI\Story Dome\Dataset\ConStory-Bench\Dataset\valid\prompts.parquet')
SEED = 'P2R-DS08-v2-20261030'

def save(name, data):
    target = ROOT / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')

old = [json.loads(p.read_text(encoding='utf-8')) for split in ['dev', 'acceptance'] for p in (V1 / split).glob('*.json')]
old_ids = {row['id'] for row in old}
old_texts = {row['prompt'] for row in old}
rows = pq.read_table(SOURCE).to_pylist()
source_hash = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
selected, audit = [], []
for task in sorted({r['task_type'] for r in rows}):
    candidates = list(enumerate(rows))
    candidates = [(i, r) for i, r in candidates if r['task_type'] == task]
    random.Random(f'{SEED}:valid:{task}').shuffle(candidates)
    count = 0
    for index, row in candidates:
        prompt, reason = row['prompt'], None
        if row['id'] in old_ids or prompt in old_texts:
            reason = 'already used in DS08 v1 (dev or acceptance)'
        elif row['language'] != 'en':
            reason = 'language is not en'
        elif re.search(r'\bsingle[- ]scene\b|\bonly one scene\b', prompt, re.I):
            reason = 'single-scene request'
        else:
            lengths = [int(n.replace(',', '')) for n in re.findall(r'\b(\d[\d,]*)\s*(?:words?|word[- ]long)\b', prompt, re.I)]
            if lengths and max(lengths) < 1500:
                reason = 'explicit total word limit below 1500'
        audit.append({'id': row['id'], 'rowIndex0': index, 'task_type': task, 'eligible': reason is None, 'reason': reason or 'selected; manually check the exact prompt before freezing'})
        if reason:
            continue
        selected.append({'record': {k: row[k] for k in ['id', 'language', 'task_type', 'prompt']}, 'source': {'file': str(SOURCE), 'sha256': source_hash, 'rowIndex0': index, 'rowNumber1': index + 1, 'id': row['id']}})
        count += 1
        if count == 3:
            break
    if count != 3:
        raise RuntimeError(f'Insufficient eligible valid/{task}')
save('build/selected-records.json', {'valid': selected})
save('labels/selection-audit.json', {'seed': SEED, 'algorithm': 'Python Random string-seeded independent shuffle per task; first eligible rows; exclude every v1 id and exact prompt', 'excludedV1Ids': sorted(old_ids), 'sourceSha256': source_hash, 'pyarrowVersion': __import__('pyarrow').__version__, 'decisions': audit})
for item in selected:
    print(json.dumps(item['record'], ensure_ascii=False))
