# PR Stats Action 📊

A GitHub Action that analyzes pull request statistics for any repository, including:

- ⏱️ **Cycle Time** — Time from PR open to merge
- 🚀 **Lead Time** — Time from first commit to merge  
- ⏰ **Time to First Review** — How long until someone reviews
- ✅ **Time to Approval** — How long until PR is approved
- 💬 **Comments & Reviews** — Discussion activity
- 📝 **Commits After Open** — Changes during review
- 📦 **Code Changes** — Lines added/deleted, files changed
- 👥 **Contributors** — Who's contributing

## Quick Start

### Use as a GitHub Action

Add this to your repository's `.github/workflows/pr-stats.yml`:

```yaml
name: PR Stats Report

on:
  schedule:
    - cron: '0 9 * * 1'  # Weekly on Monday
  workflow_dispatch:      # Manual trigger

jobs:
  analyze:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Analyze PR stats
        id: stats
        uses: YOUR_USERNAME/pr-stats-action@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          days: '90'
      
      - name: Upload report
        uses: actions/upload-artifact@v4
        with:
          name: pr-stats
          path: |
            pr-stats-reports/*.csv
            pr-stats-reports/*.html
```

### Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `repository` | Repository to analyze (`owner/repo`) | No | Current repo |
| `days` | Number of days to look back | No | `7` |
| `token` | GitHub token | Yes | `github.token` |
| `output-path` | Directory for CSV output | No | `pr-stats-reports` |

### Outputs

| Output | Description |
|--------|-------------|
| `csv-file` | Path to generated CSV file |
| `html-file` | Path to generated HTML report |
| `total-prs` | Number of PRs analyzed |
| `merge-rate` | Percentage of merged PRs |

## Examples

### Analyze Current Repository

```yaml
- uses: YOUR_USERNAME/pr-stats-action@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
```

### Analyze a Different Repository

```yaml
- uses: YOUR_USERNAME/pr-stats-action@v1
  with:
    repository: 'facebook/react'
    token: ${{ secrets.PAT_TOKEN }}  # Need PAT for other repos
    days: '30'
```

### Analyze Multiple Repositories

```yaml
jobs:
  analyze:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        repo:
          - owner/repo-1
          - owner/repo-2
          - owner/repo-3
    steps:
      - uses: YOUR_USERNAME/pr-stats-action@v1
        with:
          repository: ${{ matrix.repo }}
          token: ${{ secrets.PAT_TOKEN }}
```

### Post Summary to PR

```yaml
- name: Analyze PR stats
  id: stats
  uses: YOUR_USERNAME/pr-stats-action@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}

- name: Post summary
  run: |
    echo "## 📊 PR Stats" >> $GITHUB_STEP_SUMMARY
    echo "- Total PRs: ${{ steps.stats.outputs.total-prs }}" >> $GITHUB_STEP_SUMMARY
    echo "- Merge Rate: ${{ steps.stats.outputs.merge-rate }}%" >> $GITHUB_STEP_SUMMARY
```

## Run Locally

### Prerequisites

- Node.js 18+
- GitHub Personal Access Token

### Setup

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/pr-stats-action.git
cd pr-stats-action

# Install dependencies
npm install

# Create .env file
echo "GITHUB_TOKEN=your_token_here" > .env

# Run analysis (default: last 7 days)
npm start owner/repo

# Or specify days to look back
npm start owner/repo 30
```

### Output

The tool generates two files:

#### 📄 CSV File
A detailed spreadsheet with stats for each PR:

| Column | Description |
|--------|-------------|
| PR Number | Pull request number |
| Title | PR title |
| Author | Who created it |
| Status | Merged or Closed |
| Cycle Time (Days) | PR open → merge |
| Lead Time (Days) | First commit → merge |
| Time to First Review | Until first review |
| Total Comments | All comments |
| Total Reviews | Review submissions |
| Approvals | Number of approvals |
| Additions/Deletions | Lines changed |
| ... | And more! |

#### 📊 HTML Report
A beautiful, self-contained HTML report with:

- **Summary cards** — Key metrics at a glance (total PRs, merge rate, avg cycle time)
- **Top contributors** — Bar chart of most active authors
- **Weekly trends** — Sparkline showing PR activity over time
- **Timing metrics** — Cycle time, lead time, review timing breakdowns
- **Review metrics** — Comments, reviews, approvals, changes requested
- **Code metrics** — Additions, deletions, files changed
- **Full PR table** — Searchable list of all analyzed PRs

The HTML file is completely self-contained with embedded data and styling — just open it in any browser!

## Token Permissions

| Scenario | Token Type | Scopes Needed |
|----------|------------|---------------|
| Public repos | `GITHUB_TOKEN` | (automatic) |
| Private repos (same org) | `GITHUB_TOKEN` | (automatic) |
| Private repos (other) | Personal Access Token | `repo` |
| Cross-org repos | Personal Access Token | `repo` |

## License

MIT
