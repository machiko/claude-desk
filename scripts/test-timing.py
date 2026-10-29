#!/usr/bin/env python3
"""讀 `claude plugin test` 的輸出檔，印出支數與時間，並檢查門檻。

用法：
  claude plugin test . > .task/test-out.txt 2>&1
  python3 scripts/test-timing.py .task/test-out.txt --min-tests 460 --baseline .task/baseline-tests.txt
  python3 scripts/test-timing.py .task/test-out.txt --names > .task/baseline-tests.txt

時間只印不擋：沒給 --max-cpu、--max-wall、--max-test-ms、--max-slow 時，再慢也是 exit 0。
擋的是：有測試沒過（fail、skip、todo）、輸出不完整（沒有 Ran 總結行）、支數不足、名單上的測試不見或沒過。
"""
import argparse
import os
import re
import sys
from collections import Counter

FILE_HEADER = re.compile(r'^(\S+\.test\.tsx?):$')
TEST_ROW = re.compile(r'^\((\w+)\) (.+?)(?: \[([\d.]+)(ms|s)\])?$')
COUNT_ROW = re.compile(r'^\s*(\d+) (pass|fail|skip|todo)$')
RAN_ROW = re.compile(r'^Ran (\d+) tests? across (\d+) files?\. \[([\d.]+)(ms|s)\]$')
TOP = 10


def to_ms(value, unit):
    return float(value) * (1000 if unit == 's' else 1)


def parse(text):
    """回傳 tests（檔名、名稱、狀態、毫秒）、總結行的計數與 Ran 行（沒有就是 None）。"""
    tests, counts, ran = [], {}, None
    current = ''
    for raw in text.splitlines():
        line = raw.rstrip('\r')
        header = FILE_HEADER.match(line)
        if header:
            current = header.group(1)
            continue
        row = TEST_ROW.match(line)
        if row:
            status, name, value, unit = row.groups()
            tests.append((current, name, status, to_ms(value, unit) if value else 0.0))
            continue
        count = COUNT_ROW.match(line)
        if count:
            counts[count.group(2)] = int(count.group(1))
            continue
        summary = RAN_ROW.match(line)
        if summary:
            ran = {'tests': int(summary.group(1)), 'files': int(summary.group(2)),
                   'wall_ms': to_ms(summary.group(3), summary.group(4))}
    return tests, counts, ran


def read_baseline(path):
    with open(path, encoding='utf-8') as f:
        return Counter(tuple(line.split('\t', 1)) for line in f.read().splitlines() if '\t' in line)


def fmt_s(ms):
    return f'{ms / 1000:.1f} 秒'


def summary_lines(tests, ran, slow_ms):
    total = sum(t[3] for t in tests)
    slow = [t for t in tests if t[3] >= slow_ms]
    lines = [
        f'支數：{ran["tests"] if ran else len(tests)}（{ran["files"] if ran else "?"} 檔）',
        f'各支時間加總：{fmt_s(total)}',
        f'實際時間：{fmt_s(ran["wall_ms"]) if ran else "未知（沒有 Ran 總結行）"}',
        f'≥ {slow_ms:g} ms：{len(slow)} 支',
        f'最慢 {TOP} 支：',
        *[f'  {t[3]:9.1f} ms  {t[0]}  {t[1]}' for t in sorted(tests, key=lambda t: -t[3])[:TOP]],
        f'各檔加總前 {TOP} 名：',
    ]
    per_file = Counter()
    for t in tests:
        per_file[t[0]] += t[3]
    lines += [f'  {fmt_s(ms):>9}  {name}' for name, ms in per_file.most_common(TOP)]
    try:
        lines.append('load average：' + ' '.join(f'{x:.2f}' for x in os.getloadavg()))
    except OSError:
        lines.append('load average：讀不到')
    return lines


def problems(tests, counts, ran, args, baseline):
    found = []
    if ran is None:
        found.append('輸出不完整：沒有「Ran N tests across M files」總結行')
    elif ran['tests'] != len(tests):
        found.append(f'解析到 {len(tests)} 支，總結行寫 {ran["tests"]} 支')
    for file, name, status, _ in tests:
        if status != 'pass':
            found.append(f'沒通過（{status}）：{file}  {name}')
    for kind in ('fail', 'skip', 'todo'):
        if counts.get(kind):
            found.append(f'總結行：{counts[kind]} {kind}')
    count = ran['tests'] if ran else len(tests)
    if args.min_tests is not None and count < args.min_tests:
        found.append(f'支數 {count} 少於 {args.min_tests}（少 {args.min_tests - count} 支）')
    total = sum(t[3] for t in tests)
    if args.max_cpu is not None and total > args.max_cpu * 1000:
        found.append(f'各支時間加總 {fmt_s(total)} 超過 {args.max_cpu:g} 秒（多 {fmt_s(total - args.max_cpu * 1000)}）')
    if args.max_wall is not None and ran and ran['wall_ms'] > args.max_wall * 1000:
        found.append(f'實際時間 {fmt_s(ran["wall_ms"])} 超過 {args.max_wall:g} 秒（多 {fmt_s(ran["wall_ms"] - args.max_wall * 1000)}）')
    if args.max_test_ms is not None:
        for file, name, _, ms in tests:
            if ms > args.max_test_ms:
                found.append(f'單支 {ms:.1f} ms 超過 {args.max_test_ms:g} ms（多 {ms - args.max_test_ms:.1f} ms）：{file}  {name}')
    slow = sum(1 for t in tests if t[3] >= args.slow_ms)
    if args.max_slow is not None and slow > args.max_slow:
        found.append(f'≥ {args.slow_ms:g} ms 有 {slow} 支，超過 {args.max_slow} 支（多 {slow - args.max_slow} 支）')
    if baseline is not None:
        passed = Counter((t[0], t[1]) for t in tests if t[2] == 'pass')
        seen = Counter((t[0], t[1]) for t in tests)
        for (file, name), want in sorted(baseline.items()):
            if passed[(file, name)] >= want:
                continue
            what = '沒出現' if seen[(file, name)] < want else '沒通過'
            found.append(f'名單上的測試{what}：{file}  {name}')
    return found


def main(argv=None):
    p = argparse.ArgumentParser(description='claude plugin test 輸出的支數與時間檢查')
    p.add_argument('output', help='claude plugin test 的輸出檔（含 stderr）')
    p.add_argument('--min-tests', type=int)
    p.add_argument('--max-cpu', type=float, help='各支時間加總上限（秒）')
    p.add_argument('--max-wall', type=float, help='實際時間上限（秒）')
    p.add_argument('--max-test-ms', type=float, help='單支上限（毫秒）')
    p.add_argument('--slow-ms', type=float, default=500, help='算慢的門檻（毫秒，預設 500）')
    p.add_argument('--max-slow', type=int, help='≥ slow-ms 的支數上限')
    p.add_argument('--baseline', help='名單檔：一行一支「檔名 TAB 測試名稱」，每支都要在而且通過')
    p.add_argument('--names', action='store_true', help='只印「檔名 TAB 測試名稱」一行一支')
    args = p.parse_args(argv)

    with open(args.output, encoding='utf-8', errors='replace') as f:
        tests, counts, ran = parse(f.read())

    if args.names:
        if ran is None:
            print('輸出不完整：沒有「Ran N tests across M files」總結行', file=sys.stderr)
            return 1
        for file, name, _, _ in tests:
            print(f'{file}\t{name}')
        return 0

    baseline = read_baseline(args.baseline) if args.baseline else None
    print('\n'.join(summary_lines(tests, ran, args.slow_ms)))
    found = problems(tests, counts, ran, args, baseline)
    if found:
        print(f'\n不符合（{len(found)} 條）：')
        print('\n'.join(f'- {x}' for x in found))
        return 1
    print('\n全部符合')
    return 0


if __name__ == '__main__':
    sys.exit(main())
