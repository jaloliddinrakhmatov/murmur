"""Stream a FLEURS audio tarball from stdin and keep the first N clips that have a transcript.

Usage: curl ... test.tar.gz | python3 -I extract_fleurs.py <out_dir> <count>
Writes <out_dir>/<file>.wav and <out_dir>/manifest.tsv (file, transcript). Stops reading early,
so only a fraction of the archive is downloaded.
"""

import csv
import os
import sys
import tarfile

out_dir, count = sys.argv[1], int(sys.argv[2])

transcripts = {}
with open(os.path.join(out_dir, "test.tsv"), newline="", encoding="utf-8") as f:
    for row in csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
        # FLEURS columns: id, file_name, raw_transcription, transcription, phonemes, num_samples, gender
        if len(row) >= 3:
            transcripts[row[1]] = row[2]

kept = []
with tarfile.open(fileobj=sys.stdin.buffer, mode="r|gz") as tar:
    for member in tar:
        name = os.path.basename(member.name)
        if not member.isfile() or not name.endswith(".wav") or name not in transcripts:
            continue
        data = tar.extractfile(member).read()
        with open(os.path.join(out_dir, name), "wb") as w:
            w.write(data)
        kept.append((name, transcripts[name]))
        if len(kept) >= count:
            break

with open(os.path.join(out_dir, "manifest.tsv"), "w", newline="", encoding="utf-8") as f:
    writer = csv.writer(f, delimiter="\t")
    for row in kept:
        writer.writerow(row)

print(f"kept {len(kept)} clips in {out_dir}")
