# Changelog

## v1.1.0 (2026-04-02)

### Added

- **`exclude-contributors` input** — Comma-separated GitHub usernames whose PRs are dropped from the CSV, HTML report, and all aggregates. Defaults to `github-actions`. Use an empty value to disable filtering.

### Fixed

- Match GitHub’s bot login form (`github-actions[bot]`, etc.) when excluding, so automation PRs are actually removed from reports.

## v1.0.1 (2026-04-02)

### Fixed

- Compute merge rate with bash integer math instead of `bc`, so the action runs on GitHub-hosted runners where `bc` is not installed (avoids exit code 127).

## v1.0.0 (2026-03-10)

### 🎉 Initial Release

PR Stats Action is a GitHub Action that analyzes pull request statistics for any repository, providing insights into team velocity, code review practices, and development workflow health.

### ✨ Features

#### Metrics & Analytics
- **Cycle Time** — Time from PR open to merge
- **Lead Time** — Time from first commit to merge (DORA metric)
- **Time to First Review** — How long until someone starts reviewing
- **Time to Approval** — How long until PR gets approved
- **Review Activity** — Comments, approvals, changes requested
- **Code Churn** — Lines added, deleted, files changed
- **Contributor Stats** — Top contributors, unique authors

#### Output Formats
- **📄 CSV Export** — Detailed spreadsheet with all PR data for further analysis
- **📊 HTML Report** — Beautiful, self-contained dashboard with:
  - Summary stat cards (total PRs, merge rate, avg cycle time)
  - Top contributors bar chart
  - Weekly activity sparkline (12 weeks)
  - Timing metrics breakdown (avg, median, min, max)
  - Review & code change metrics
  - Full searchable PR table

#### Configuration
- **Configurable lookback period** — Default 7 days, customizable via `days` input
- **Cross-repository analysis** — Analyze any public repo or private repos with PAT
- **Works with GitHub Actions** — Native composite action, no Docker required

### 📦 Installation

```yaml
- uses: YOUR_USERNAME/pr-stats-action@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    days: '7'
```

### 🖥️ CLI Usage

```bash
npm start owner/repo        # Last 7 days
npm start owner/repo 30     # Last 30 days
```

### 📋 Outputs

| Output | Description |
|--------|-------------|
| `csv-file` | Path to generated CSV file |
| `html-file` | Path to generated HTML report |
| `total-prs` | Number of PRs analyzed |
| `merge-rate` | Percentage of merged PRs |

---

**Full Changelog**: https://github.com/YOUR_USERNAME/pr-stats-action/commits/v1.0.0
