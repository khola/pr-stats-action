import fetch from 'node-fetch';
import dotenv from 'dotenv';
import fs from 'fs/promises';

// Load environment variables
dotenv.config();

/**
 * GitHub GraphQL API Client
 */
class GitHubGraphQLClient {
  constructor(token) {
    this.token = token;
    this.endpoint = 'https://api.github.com/graphql';
  }

  /**
   * Sleep for a given number of milliseconds
   * @param {number} ms - Milliseconds to sleep
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Execute a GraphQL query with retry logic
   * @param {string} query - GraphQL query string
   * @param {object} variables - Query variables (optional)
   * @param {number} retries - Number of retries (default: 3)
   * @returns {Promise<object>} - Response data
   */
  async query(query, variables = {}, retries = 3) {
    let lastError;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000); // 60 second timeout
        
        const response = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.token}`,
            'User-Agent': 'pr-stats-action'
          },
          body: JSON.stringify({
            query,
            variables
          }),
          signal: controller.signal
        });
        
        clearTimeout(timeout);

        if (!response.ok) {
          const errorText = await response.text();
          
          // Handle rate limiting
          if (response.status === 403 || response.status === 429) {
            const retryAfter = response.headers.get('Retry-After') || 60;
            console.log(`⏳ Rate limited. Waiting ${retryAfter} seconds...`);
            await this.sleep(retryAfter * 1000);
            continue;
          }
          
          throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
        }

        const data = await response.json();

        if (data.errors) {
          // Check for timeout errors in GraphQL response
          const hasTimeout = data.errors.some(e => 
            e.message?.toLowerCase().includes('timeout') ||
            e.type === 'TIMEOUT'
          );
          
          if (hasTimeout && attempt < retries) {
            console.log(`⏳ Query timeout (attempt ${attempt}/${retries}). Retrying...`);
            await this.sleep(2000 * attempt); // Exponential backoff
            continue;
          }
          
          throw new Error(`GraphQL errors: ${JSON.stringify(data.errors, null, 2)}`);
        }

        return data.data;
      } catch (error) {
        lastError = error;
        
        if (error.name === 'AbortError') {
          console.log(`⏳ Request timeout (attempt ${attempt}/${retries}). Retrying...`);
        } else if (attempt < retries) {
          console.log(`⚠️ Error (attempt ${attempt}/${retries}): ${error.message}. Retrying...`);
        }
        
        if (attempt < retries) {
          await this.sleep(2000 * attempt); // Exponential backoff
        }
      }
    }
    
    console.error('Error executing GraphQL query:', lastError.message);
    throw lastError;
  }

  /**
   * Get user information
   * @param {string} username - GitHub username
   * @returns {Promise<object>} - User data
   */
  async getUser(username) {
    const query = `
      query GetUser($username: String!) {
        user(login: $username) {
          id
          login
          name
          bio
          email
          avatarUrl
          url
          company
          location
          followers {
            totalCount
          }
          following {
            totalCount
          }
          repositories {
            totalCount
          }
          createdAt
        }
      }
    `;

    return this.query(query, { username });
  }

  /**
   * Get repository information
   * @param {string} owner - Repository owner
   * @param {string} name - Repository name
   * @returns {Promise<object>} - Repository data
   */
  async getRepository(owner, name) {
    const query = `
      query GetRepository($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          id
          name
          description
          url
          stargazerCount
          forkCount
          isPrivate
          isArchived
          createdAt
          updatedAt
          pushedAt
          owner {
            login
            avatarUrl
          }
          primaryLanguage {
            name
            color
          }
          defaultBranchRef {
            name
          }
        }
      }
    `;

    return this.query(query, { owner, name });
  }

  /**
   * Search repositories
   * @param {string} query - Search query
   * @param {number} first - Number of results (default: 10)
   * @returns {Promise<object>} - Search results
   */
  async searchRepositories(query, first = 10) {
    const graphqlQuery = `
      query SearchRepositories($query: String!, $first: Int!) {
        search(query: $query, type: REPOSITORY, first: $first) {
          repositoryCount
          edges {
            node {
              ... on Repository {
                id
                name
                description
                url
                stargazerCount
                forkCount
                owner {
                  login
                  avatarUrl
                }
                primaryLanguage {
                  name
                  color
                }
              }
            }
          }
        }
      }
    `;

    return this.query(graphqlQuery, { query, first });
  }

  /**
   * Fetch all closed/merged pull requests for a repository
   * @param {string} owner - Repository owner
   * @param {string} name - Repository name
   * @param {number} daysBack - Number of days to look back (default: 90)
   * @param {number} perPage - Number of PRs per page (max 50 for complex queries)
   * @returns {Promise<Array>} - Array of PR data
   */
  async getAllClosedMergedPRs(owner, name, daysBack = 90, perPage = 30) {
    const allPRs = [];
    let hasNextPage = true;
    let cursor = null;
    let pageNum = 0;
    
    // Calculate cutoff date
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysBack);
    console.log(`📅 Fetching PRs merged/closed in the last ${daysBack} days (since ${cutoffDate.toISOString().split('T')[0]})\n`);

    while (hasNextPage) {
      pageNum++;
      
      // Add delay between requests to avoid rate limiting
      if (pageNum > 1) {
        await this.sleep(500);
      }
      
      const query = `
        query GetPRs($owner: String!, $name: String!, $first: Int!, $after: String) {
          repository(owner: $owner, name: $name) {
            pullRequests(
              states: [CLOSED, MERGED]
              first: $first
              after: $after
              orderBy: { field: UPDATED_AT, direction: DESC }
            ) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                number
                title
                state
                url
                createdAt
                closedAt
                mergedAt
                merged
                author {
                  login
                }
                baseRefName
                headRefName
                additions
                deletions
                changedFiles
                commitsCount: commits {
                  totalCount
                }
                comments {
                  totalCount
                }
                reviewThreads(first: 50) {
                  totalCount
                  nodes {
                    comments {
                      totalCount
                    }
                  }
                }
                reviewsCount: reviews {
                  totalCount
                }
                commits(first: 50) {
                  nodes {
                    commit {
                      committedDate
                      authoredDate
                    }
                  }
                }
                reviews(first: 50) {
                  nodes {
                    id
                    state
                    submittedAt
                    author {
                      login
                    }
                    body
                  }
                }
                reviewRequests(first: 10) {
                  nodes {
                    requestedReviewer {
                      ... on User {
                        login
                      }
                    }
                  }
                }
                labels(first: 20) {
                  nodes {
                    name
                  }
                }
                isDraft
              }
            }
          }
        }
      `;

      const variables = {
        owner,
        name,
        first: perPage,
        after: cursor
      };

      const data = await this.query(query, variables);
      const prs = data.repository?.pullRequests?.nodes || [];
      
      // Filter PRs by merge/close date and check if we should stop
      let oldPRsCount = 0;
      for (const pr of prs) {
        // Use mergedAt if merged, otherwise closedAt
        const completionDate = pr.mergedAt || pr.closedAt;
        if (completionDate && new Date(completionDate) >= cutoffDate) {
          allPRs.push(pr);
        } else {
          oldPRsCount++;
        }
      }
      
      // If all PRs in this page are old, we've likely fetched all recent ones
      const reachedCutoff = oldPRsCount === prs.length && prs.length > 0;

      const pageInfo = data.repository?.pullRequests?.pageInfo;
      hasNextPage = (pageInfo?.hasNextPage || false) && !reachedCutoff;
      cursor = pageInfo?.endCursor || null;

      console.log(`📥 Page ${pageNum}: Fetched ${prs.length} PRs, kept ${allPRs.length} within date range (${oldPRsCount} older)`);
      
      if (reachedCutoff) {
        console.log(`📅 All PRs on this page are older than ${daysBack} days, stopping pagination`);
      }
    }
    
    console.log(`✅ Completed: ${allPRs.length} PRs from the last ${daysBack} days`);
    
    return allPRs;
  }
}

/**
 * Calculate time difference in hours
 * @param {string} startDate - ISO date string
 * @param {string} endDate - ISO date string
 * @returns {number} - Time difference in hours
 */
function calculateTimeDifference(startDate, endDate) {
  if (!startDate || !endDate) return null;
  const start = new Date(startDate);
  const end = new Date(endDate);
  return (end - start) / (1000 * 60 * 60); // Convert to hours
}

/**
 * Calculate statistics for a single PR
 * @param {object} pr - PR data from GraphQL
 * @returns {object} - Calculated statistics
 */
function calculatePRStats(pr) {
  const stats = {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    merged: pr.merged,
    author: pr.author?.login || 'unknown',
    url: pr.url,
    createdAt: pr.createdAt,
    closedAt: pr.closedAt,
    mergedAt: pr.mergedAt,
  };

  // Cycle time: time from PR open to merge/close
  if (pr.mergedAt) {
    stats.cycleTimeHours = calculateTimeDifference(pr.createdAt, pr.mergedAt);
    stats.cycleTimeDays = stats.cycleTimeHours ? (stats.cycleTimeHours / 24).toFixed(2) : null;
  } else if (pr.closedAt) {
    stats.cycleTimeHours = calculateTimeDifference(pr.createdAt, pr.closedAt);
    stats.cycleTimeDays = stats.cycleTimeHours ? (stats.cycleTimeHours / 24).toFixed(2) : null;
  }

  // Get all commits from the PR (includes commits before and after PR was opened)
  const prCommits = pr.commits?.nodes || [];
  
  // Extract commit dates
  const allCommits = prCommits
    .map(item => {
      const commit = item.commit;
      // Use authoredDate (when code was written) for lead time, not committedDate (when it was applied)
      const commitDate = commit?.authoredDate || commit?.committedDate || commit?.author?.date;
      return commitDate ? {
        date: commitDate,
        message: commit?.message
      } : null;
    })
    .filter(Boolean);

  // Lead time: time from first commit to merge/close
  if (allCommits.length > 0) {
    // Find the earliest commit date (authored date)
    const commitDates = allCommits
      .map(c => new Date(c.date))
      .sort((a, b) => a - b);
    
    const firstCommitDate = commitDates[0];
    const endDate = pr.mergedAt || pr.closedAt;
    
    if (endDate) {
      stats.leadTimeHours = calculateTimeDifference(firstCommitDate.toISOString(), endDate);
      stats.leadTimeDays = stats.leadTimeHours ? (stats.leadTimeHours / 24).toFixed(2) : null;
      stats.firstCommitDate = firstCommitDate.toISOString();
    }
  }

  // Number of commits after PR open (indicates iteration/changes during review)
  const commitsAfterOpen = allCommits.filter(commit => {
    return new Date(commit.date) > new Date(pr.createdAt);
  });
  stats.commitsAfterOpen = commitsAfterOpen.length;
  stats.totalCommits = pr.commitsCount?.totalCount || 0;

  // Comments statistics
  stats.prComments = pr.comments?.totalCount || 0; // General PR discussion comments
  stats.reviewThreads = pr.reviewThreads?.totalCount || 0; // Inline code review threads
  
  // Count all inline review comments (comments within review threads)
  const reviewThreadNodes = pr.reviewThreads?.nodes || [];
  stats.inlineComments = reviewThreadNodes.reduce((sum, thread) => {
    return sum + (thread.comments?.totalCount || 0);
  }, 0);
  
  // Total comments = PR comments + inline review comments
  stats.totalComments = stats.prComments + stats.inlineComments;
  
  stats.totalReviews = pr.reviewsCount?.totalCount || 0;

  // Review breakdown
  const reviews = pr.reviews?.nodes || [];
  stats.approvals = reviews.filter(r => r.state === 'APPROVED').length;
  stats.changesRequested = reviews.filter(r => r.state === 'CHANGES_REQUESTED').length;
  stats.commentedReviews = reviews.filter(r => r.state === 'COMMENTED').length;
  stats.dismissedReviews = reviews.filter(r => r.state === 'DISMISSED').length;

  // Reviewers
  stats.reviewers = [...new Set(reviews.map(r => r.author?.login).filter(Boolean))];
  stats.uniqueReviewers = stats.reviewers.length;
  stats.requestedReviewers = pr.reviewRequests?.nodes?.length || 0;

  // Code changes
  stats.additions = pr.additions || 0;
  stats.deletions = pr.deletions || 0;
  stats.changedFiles = pr.changedFiles || 0;
  stats.netChanges = stats.additions - stats.deletions;

  // Other metadata
  stats.isDraft = pr.isDraft || false;
  stats.labels = pr.labels?.nodes?.map(l => l.name) || [];
  stats.baseRef = pr.baseRefName;
  stats.headRef = pr.headRefName;

  // Time to first review (if any reviews exist)
  if (reviews.length > 0) {
    const sortedReviews = reviews
      .filter(r => r.submittedAt)
      .sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt));
    if (sortedReviews.length > 0) {
      stats.timeToFirstReviewHours = calculateTimeDifference(pr.createdAt, sortedReviews[0].submittedAt);
      stats.timeToFirstReviewDays = stats.timeToFirstReviewHours ? (stats.timeToFirstReviewHours / 24).toFixed(2) : null;
    }
  }

  // Time to approval (if approved)
  const approvals = reviews.filter(r => r.state === 'APPROVED' && r.submittedAt);
  if (approvals.length > 0) {
    const firstApproval = approvals.sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt))[0];
    stats.timeToApprovalHours = calculateTimeDifference(pr.createdAt, firstApproval.submittedAt);
    stats.timeToApprovalDays = stats.timeToApprovalHours ? (stats.timeToApprovalHours / 24).toFixed(2) : null;
  }

  return stats;
}

/**
 * Aggregate statistics across all PRs
 * @param {Array} prStats - Array of PR statistics
 * @returns {object} - Aggregated statistics
 */
function aggregateStats(prStats) {
  const merged = prStats.filter(p => p.merged);
  const closed = prStats.filter(p => !p.merged && p.state === 'CLOSED');

  const aggregate = {
    total: prStats.length,
    merged: merged.length,
    closed: closed.length,
    mergedPercentage: ((merged.length / prStats.length) * 100).toFixed(2),
  };

  // Cycle time statistics (for merged PRs)
  const cycleTimes = merged
    .map(p => p.cycleTimeHours)
    .filter(t => t !== null && t !== undefined);
  
  if (cycleTimes.length > 0) {
    aggregate.cycleTime = {
      averageHours: (cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length).toFixed(2),
      averageDays: (cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length / 24).toFixed(2),
      medianHours: cycleTimes.sort((a, b) => a - b)[Math.floor(cycleTimes.length / 2)].toFixed(2),
      minHours: Math.min(...cycleTimes).toFixed(2),
      maxHours: Math.max(...cycleTimes).toFixed(2),
    };
  }

  // Lead time statistics (for merged PRs)
  const leadTimes = merged
    .map(p => p.leadTimeHours)
    .filter(t => t !== null && t !== undefined);
  
  if (leadTimes.length > 0) {
    aggregate.leadTime = {
      averageHours: (leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length).toFixed(2),
      averageDays: (leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length / 24).toFixed(2),
      medianHours: leadTimes.sort((a, b) => a - b)[Math.floor(leadTimes.length / 2)].toFixed(2),
      minHours: Math.min(...leadTimes).toFixed(2),
      maxHours: Math.max(...leadTimes).toFixed(2),
    };
  }

  // Comments statistics
  const totalComments = prStats.reduce((sum, p) => sum + (p.totalComments || 0), 0);
  const prComments = prStats.reduce((sum, p) => sum + (p.prComments || 0), 0);
  const inlineComments = prStats.reduce((sum, p) => sum + (p.inlineComments || 0), 0);
  const reviewThreads = prStats.reduce((sum, p) => sum + (p.reviewThreads || 0), 0);
  aggregate.comments = {
    total: totalComments,
    prComments: prComments,
    inlineComments: inlineComments,
    reviewThreads: reviewThreads,
    averagePerPR: (totalComments / prStats.length).toFixed(2),
    median: prStats.map(p => p.totalComments || 0).sort((a, b) => a - b)[Math.floor(prStats.length / 2)],
  };

  // Review statistics
  const totalReviews = prStats.reduce((sum, p) => sum + (p.totalReviews || 0), 0);
  aggregate.reviews = {
    total: totalReviews,
    averagePerPR: (totalReviews / prStats.length).toFixed(2),
    totalApprovals: prStats.reduce((sum, p) => sum + (p.approvals || 0), 0),
    totalChangesRequested: prStats.reduce((sum, p) => sum + (p.changesRequested || 0), 0),
  };

  // Commits statistics
  const commitsAfterOpen = prStats.reduce((sum, p) => sum + (p.commitsAfterOpen || 0), 0);
  aggregate.commits = {
    totalAfterOpen: commitsAfterOpen,
    averageAfterOpen: (commitsAfterOpen / prStats.length).toFixed(2),
    totalCommits: prStats.reduce((sum, p) => sum + (p.totalCommits || 0), 0),
  };

  // Code changes statistics
  aggregate.changes = {
    totalAdditions: prStats.reduce((sum, p) => sum + (p.additions || 0), 0),
    totalDeletions: prStats.reduce((sum, p) => sum + (p.deletions || 0), 0),
    totalNetChanges: prStats.reduce((sum, p) => sum + (p.netChanges || 0), 0),
    averageAdditions: (prStats.reduce((sum, p) => sum + (p.additions || 0), 0) / prStats.length).toFixed(2),
    averageDeletions: (prStats.reduce((sum, p) => sum + (p.deletions || 0), 0) / prStats.length).toFixed(2),
    totalChangedFiles: prStats.reduce((sum, p) => sum + (p.changedFiles || 0), 0),
    averageChangedFiles: (prStats.reduce((sum, p) => sum + (p.changedFiles || 0), 0) / prStats.length).toFixed(2),
  };

  // Time to first review
  const timeToFirstReview = prStats
    .map(p => p.timeToFirstReviewHours)
    .filter(t => t !== null && t !== undefined);
  
  if (timeToFirstReview.length > 0) {
    aggregate.timeToFirstReview = {
      averageHours: (timeToFirstReview.reduce((a, b) => a + b, 0) / timeToFirstReview.length).toFixed(2),
      averageDays: (timeToFirstReview.reduce((a, b) => a + b, 0) / timeToFirstReview.length / 24).toFixed(2),
    };
  }

  // Time to approval
  const timeToApproval = prStats
    .map(p => p.timeToApprovalHours)
    .filter(t => t !== null && t !== undefined);
  
  if (timeToApproval.length > 0) {
    aggregate.timeToApproval = {
      averageHours: (timeToApproval.reduce((a, b) => a + b, 0) / timeToApproval.length).toFixed(2),
      averageDays: (timeToApproval.reduce((a, b) => a + b, 0) / timeToApproval.length / 24).toFixed(2),
    };
  }

  // Authors
  const authors = {};
  prStats.forEach(p => {
    authors[p.author] = (authors[p.author] || 0) + 1;
  });
  aggregate.authors = {
    unique: Object.keys(authors).length,
    topContributors: Object.entries(authors)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, prs: count })),
  };

  return aggregate;
}

/**
 * Escape a value for CSV (handle commas, quotes, newlines)
 * @param {any} value - Value to escape
 * @returns {string} - Escaped CSV value
 */
function escapeCSV(value) {
  if (value === null || value === undefined) {
    return '';
  }
  const str = String(value);
  // If contains comma, quote, or newline, wrap in quotes and escape existing quotes
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generate HTML report content from PR stats
 * @param {Array} prStats - Individual PR statistics
 * @param {object} aggregate - Aggregated statistics
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {string} - HTML content
 */
function generateHTML(prStats, aggregate, owner, repo) {
  const sortedPRs = [...prStats].sort((a, b) => b.number - a.number);
  const reportDate = new Date().toLocaleDateString('en-US', { 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  // Prepare chart data
  const authorData = aggregate.authors?.topContributors || [];
  const cycleTimeByWeek = calculateWeeklyStats(sortedPRs, 'cycleTimeHours');
  const prsByWeek = calculateWeeklyPRCount(sortedPRs);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PR Stats Report - ${owner}/${repo}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-primary: #0d1117;
      --bg-secondary: #161b22;
      --bg-tertiary: #21262d;
      --bg-card: #1c2128;
      --border-primary: #30363d;
      --border-accent: #388bfd;
      --text-primary: #e6edf3;
      --text-secondary: #8b949e;
      --text-muted: #6e7681;
      --accent-blue: #58a6ff;
      --accent-green: #3fb950;
      --accent-purple: #a371f7;
      --accent-orange: #d29922;
      --accent-red: #f85149;
      --accent-pink: #db61a2;
      --accent-cyan: #39c5cf;
      --gradient-1: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      --gradient-2: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
      --gradient-3: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
      --gradient-4: linear-gradient(135deg, #43e97b 0%, #38f9d7 100%);
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.6;
      min-height: 100vh;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 2rem;
    }

    /* Header */
    .header {
      background: linear-gradient(135deg, rgba(88, 166, 255, 0.1) 0%, rgba(163, 113, 247, 0.1) 100%);
      border: 1px solid var(--border-primary);
      border-radius: 16px;
      padding: 2.5rem;
      margin-bottom: 2rem;
      position: relative;
      overflow: hidden;
    }

    .header::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: var(--gradient-1);
    }

    .header h1 {
      font-size: 2.25rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
      background: linear-gradient(135deg, var(--accent-blue), var(--accent-purple));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .header .repo-name {
      font-family: 'JetBrains Mono', monospace;
      font-size: 1.1rem;
      color: var(--text-secondary);
      margin-bottom: 0.5rem;
    }

    .header .report-date {
      font-size: 0.875rem;
      color: var(--text-muted);
    }

    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }

    .stat-card {
      background: var(--bg-card);
      border: 1px solid var(--border-primary);
      border-radius: 12px;
      padding: 1.5rem;
      position: relative;
      overflow: hidden;
      transition: transform 0.2s, border-color 0.2s;
    }

    .stat-card:hover {
      transform: translateY(-2px);
      border-color: var(--border-accent);
    }

    .stat-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 4px;
      height: 100%;
    }

    .stat-card.blue::before { background: var(--accent-blue); }
    .stat-card.green::before { background: var(--accent-green); }
    .stat-card.purple::before { background: var(--accent-purple); }
    .stat-card.orange::before { background: var(--accent-orange); }
    .stat-card.pink::before { background: var(--accent-pink); }
    .stat-card.cyan::before { background: var(--accent-cyan); }

    .stat-card .label {
      font-size: 0.75rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 0.5rem;
    }

    .stat-card .value {
      font-size: 2rem;
      font-weight: 700;
      font-family: 'JetBrains Mono', monospace;
    }

    .stat-card.blue .value { color: var(--accent-blue); }
    .stat-card.green .value { color: var(--accent-green); }
    .stat-card.purple .value { color: var(--accent-purple); }
    .stat-card.orange .value { color: var(--accent-orange); }
    .stat-card.pink .value { color: var(--accent-pink); }
    .stat-card.cyan .value { color: var(--accent-cyan); }

    .stat-card .subtext {
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin-top: 0.25rem;
    }

    /* Section */
    .section {
      background: var(--bg-card);
      border: 1px solid var(--border-primary);
      border-radius: 12px;
      margin-bottom: 2rem;
      overflow: hidden;
    }

    .section-header {
      padding: 1.25rem 1.5rem;
      border-bottom: 1px solid var(--border-primary);
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .section-header h2 {
      font-size: 1.1rem;
      font-weight: 600;
    }

    .section-header .icon {
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-tertiary);
      border-radius: 6px;
      font-size: 0.875rem;
    }

    .section-content {
      padding: 1.5rem;
    }

    /* Charts Row */
    .charts-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
      gap: 2rem;
    }

    .chart-container {
      background: var(--bg-secondary);
      border-radius: 8px;
      padding: 1.5rem;
    }

    .chart-title {
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--text-secondary);
      margin-bottom: 1rem;
    }

    /* Bar Chart */
    .bar-chart {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .bar-item {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .bar-label {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      color: var(--text-secondary);
      min-width: 100px;
      text-align: right;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .bar-track {
      flex: 1;
      height: 24px;
      background: var(--bg-tertiary);
      border-radius: 4px;
      overflow: hidden;
      position: relative;
    }

    .bar-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.5s ease;
      display: flex;
      align-items: center;
      padding-left: 0.5rem;
    }

    .bar-fill span {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--bg-primary);
    }

    .bar-fill.gradient-1 { background: var(--gradient-1); }
    .bar-fill.gradient-2 { background: var(--gradient-2); }
    .bar-fill.gradient-3 { background: var(--gradient-3); }
    .bar-fill.gradient-4 { background: var(--gradient-4); }

    /* Metrics Grid */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1.5rem;
    }

    .metric-group {
      background: var(--bg-secondary);
      border-radius: 8px;
      padding: 1.25rem;
    }

    .metric-group-title {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 1rem;
      padding-bottom: 0.75rem;
      border-bottom: 1px solid var(--border-primary);
    }

    .metric-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.5rem 0;
    }

    .metric-row:not(:last-child) {
      border-bottom: 1px dashed var(--border-primary);
    }

    .metric-name {
      font-size: 0.875rem;
      color: var(--text-secondary);
    }

    .metric-value {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--text-primary);
    }

    /* Table */
    .table-container {
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }

    thead {
      background: var(--bg-secondary);
      position: sticky;
      top: 0;
      z-index: 10;
    }

    th {
      padding: 1rem;
      text-align: left;
      font-weight: 600;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border-primary);
      white-space: nowrap;
    }

    td {
      padding: 0.875rem 1rem;
      border-bottom: 1px solid var(--border-primary);
      vertical-align: middle;
    }

    tbody tr:hover {
      background: rgba(88, 166, 255, 0.05);
    }

    .pr-number {
      font-family: 'JetBrains Mono', monospace;
      font-weight: 600;
      color: var(--accent-blue);
    }

    .pr-title {
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .pr-title a {
      color: var(--text-primary);
      text-decoration: none;
      transition: color 0.2s;
    }

    .pr-title a:hover {
      color: var(--accent-blue);
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 500;
    }

    .badge.merged {
      background: rgba(63, 185, 80, 0.15);
      color: var(--accent-green);
    }

    .badge.closed {
      background: rgba(248, 81, 73, 0.15);
      color: var(--accent-red);
    }

    .author {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      color: var(--text-secondary);
    }

    .mono {
      font-family: 'JetBrains Mono', monospace;
    }

    .text-green { color: var(--accent-green); }
    .text-red { color: var(--accent-red); }
    .text-muted { color: var(--text-muted); }
    .text-secondary { color: var(--text-secondary); }

    /* Sparkline */
    .sparkline {
      display: flex;
      align-items: flex-end;
      gap: 3px;
      height: 40px;
      padding: 0.5rem 0;
    }

    .sparkline-bar {
      flex: 1;
      min-width: 20px;
      max-width: 40px;
      background: var(--gradient-3);
      border-radius: 2px 2px 0 0;
      transition: opacity 0.2s;
    }

    .sparkline-bar:hover {
      opacity: 0.8;
    }

    /* Footer */
    .footer {
      text-align: center;
      padding: 2rem;
      color: var(--text-muted);
      font-size: 0.875rem;
    }

    .footer a {
      color: var(--accent-blue);
      text-decoration: none;
    }

    /* Responsive */
    @media (max-width: 768px) {
      .container {
        padding: 1rem;
      }

      .header {
        padding: 1.5rem;
      }

      .header h1 {
        font-size: 1.5rem;
      }

      .charts-row {
        grid-template-columns: 1fr;
      }

      .table-container {
        font-size: 0.8rem;
      }

      th, td {
        padding: 0.5rem;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <h1>Pull Request Statistics</h1>
      <div class="repo-name">📦 ${owner}/${repo}</div>
      <div class="report-date">Generated on ${reportDate}</div>
    </header>

    <div class="stats-grid">
      <div class="stat-card blue">
        <div class="label">Total PRs</div>
        <div class="value">${aggregate.total}</div>
        <div class="subtext">Last 90 days</div>
      </div>
      <div class="stat-card green">
        <div class="label">Merged</div>
        <div class="value">${aggregate.merged}</div>
        <div class="subtext">${aggregate.mergedPercentage}% merge rate</div>
      </div>
      <div class="stat-card purple">
        <div class="label">Avg Cycle Time</div>
        <div class="value">${aggregate.cycleTime?.averageDays || '—'}</div>
        <div class="subtext">days to merge</div>
      </div>
      <div class="stat-card orange">
        <div class="label">Avg Lead Time</div>
        <div class="value">${aggregate.leadTime?.averageDays || '—'}</div>
        <div class="subtext">days from first commit</div>
      </div>
      <div class="stat-card pink">
        <div class="label">Time to Review</div>
        <div class="value">${aggregate.timeToFirstReview?.averageDays || '—'}</div>
        <div class="subtext">days average</div>
      </div>
      <div class="stat-card cyan">
        <div class="label">Contributors</div>
        <div class="value">${aggregate.authors?.unique || 0}</div>
        <div class="subtext">unique authors</div>
      </div>
    </div>

    <section class="section">
      <div class="section-header">
        <span class="icon">📊</span>
        <h2>Overview & Trends</h2>
      </div>
      <div class="section-content">
        <div class="charts-row">
          <div class="chart-container">
            <div class="chart-title">Top Contributors by PR Count</div>
            <div class="bar-chart">
              ${authorData.slice(0, 8).map((author, i) => {
                const maxPRs = Math.max(...authorData.map(a => a.prs));
                const width = (author.prs / maxPRs * 100).toFixed(1);
                const gradients = ['gradient-1', 'gradient-3', 'gradient-4', 'gradient-2'];
                return `
              <div class="bar-item">
                <div class="bar-label">${author.name}</div>
                <div class="bar-track">
                  <div class="bar-fill ${gradients[i % gradients.length]}" style="width: ${width}%">
                    <span>${author.prs}</span>
                  </div>
                </div>
              </div>`;
              }).join('')}
            </div>
          </div>
          <div class="chart-container">
            <div class="chart-title">PRs Merged Per Week (Last 12 Weeks)</div>
            <div class="sparkline">
              ${prsByWeek.map(count => {
                const maxCount = Math.max(...prsByWeek, 1);
                const height = Math.max((count / maxCount * 100), 5);
                return `<div class="sparkline-bar" style="height: ${height}%" title="${count} PRs"></div>`;
              }).join('')}
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <span class="icon">⏱️</span>
        <h2>Timing Metrics</h2>
      </div>
      <div class="section-content">
        <div class="metrics-grid">
          <div class="metric-group">
            <div class="metric-group-title">Cycle Time (PR Open → Merge)</div>
            <div class="metric-row">
              <span class="metric-name">Average</span>
              <span class="metric-value">${aggregate.cycleTime?.averageDays || '—'} days</span>
            </div>
            <div class="metric-row">
              <span class="metric-name">Median</span>
              <span class="metric-value">${aggregate.cycleTime?.medianHours ? (aggregate.cycleTime.medianHours / 24).toFixed(2) : '—'} days</span>
            </div>
            <div class="metric-row">
              <span class="metric-name">Fastest</span>
              <span class="metric-value">${aggregate.cycleTime?.minHours ? (aggregate.cycleTime.minHours / 24).toFixed(2) : '—'} days</span>
            </div>
            <div class="metric-row">
              <span class="metric-name">Slowest</span>
              <span class="metric-value">${aggregate.cycleTime?.maxHours ? (aggregate.cycleTime.maxHours / 24).toFixed(2) : '—'} days</span>
            </div>
          </div>
          <div class="metric-group">
            <div class="metric-group-title">Lead Time (First Commit → Merge)</div>
            <div class="metric-row">
              <span class="metric-name">Average</span>
              <span class="metric-value">${aggregate.leadTime?.averageDays || '—'} days</span>
            </div>
            <div class="metric-row">
              <span class="metric-name">Median</span>
              <span class="metric-value">${aggregate.leadTime?.medianHours ? (aggregate.leadTime.medianHours / 24).toFixed(2) : '—'} days</span>
            </div>
            <div class="metric-row">
              <span class="metric-name">Fastest</span>
              <span class="metric-value">${aggregate.leadTime?.minHours ? (aggregate.leadTime.minHours / 24).toFixed(2) : '—'} days</span>
            </div>
            <div class="metric-row">
              <span class="metric-name">Slowest</span>
              <span class="metric-value">${aggregate.leadTime?.maxHours ? (aggregate.leadTime.maxHours / 24).toFixed(2) : '—'} days</span>
            </div>
          </div>
          <div class="metric-group">
            <div class="metric-group-title">Review Timing</div>
            <div class="metric-row">
              <span class="metric-name">Time to First Review</span>
              <span class="metric-value">${aggregate.timeToFirstReview?.averageDays || '—'} days</span>
            </div>
            <div class="metric-row">
              <span class="metric-name">Time to Approval</span>
              <span class="metric-value">${aggregate.timeToApproval?.averageDays || '—'} days</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <span class="icon">💬</span>
        <h2>Review & Code Metrics</h2>
      </div>
      <div class="section-content">
        <div class="metrics-grid">
          <div class="metric-group">
            <div class="metric-group-title">Review Activity</div>
            <div class="metric-row">
              <span class="metric-name">Total Reviews</span>
              <span class="metric-value">${aggregate.reviews?.total || 0}</span>
            </div>
            <div class="metric-row">
              <span class="metric-name">Avg per PR</span>
              <span class="metric-value">${aggregate.reviews?.averagePerPR || 0}</span>
            </div>
            <div class="metric-row">
              <span class="metric-name">Total Approvals</span>
              <span class="metric-value">${aggregate.reviews?.totalApprovals || 0}</span>
            </div>
            <div class="metric-row">
              <span class="metric-name">Changes Requested</span>
              <span class="metric-value">${aggregate.reviews?.totalChangesRequested || 0}</span>
            </div>
          </div>
          <div class="metric-group">
            <div class="metric-group-title">Comments</div>
            <div class="metric-row">
              <span class="metric-name">Total Comments</span>
              <span class="metric-value">${aggregate.comments?.total || 0}</span>
            </div>
            <div class="metric-row">
              <span class="metric-name">Avg per PR</span>
              <span class="metric-value">${aggregate.comments?.averagePerPR || 0}</span>
            </div>
            <div class="metric-row">
              <span class="metric-name">Inline Comments</span>
              <span class="metric-value">${aggregate.comments?.inlineComments || 0}</span>
            </div>
            <div class="metric-row">
              <span class="metric-name">Review Threads</span>
              <span class="metric-value">${aggregate.comments?.reviewThreads || 0}</span>
            </div>
          </div>
          <div class="metric-group">
            <div class="metric-group-title">Code Changes</div>
            <div class="metric-row">
              <span class="metric-name">Total Additions</span>
              <span class="metric-value text-green">+${(aggregate.changes?.totalAdditions || 0).toLocaleString()}</span>
            </div>
            <div class="metric-row">
              <span class="metric-name">Total Deletions</span>
              <span class="metric-value text-red">-${(aggregate.changes?.totalDeletions || 0).toLocaleString()}</span>
            </div>
            <div class="metric-row">
              <span class="metric-name">Avg Files Changed</span>
              <span class="metric-value">${aggregate.changes?.averageChangedFiles || 0}</span>
            </div>
            <div class="metric-row">
              <span class="metric-name">Total Commits</span>
              <span class="metric-value">${aggregate.commits?.totalCommits || 0}</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <span class="icon">📋</span>
        <h2>All Pull Requests</h2>
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Title</th>
              <th>Author</th>
              <th>Status</th>
              <th>Cycle Time</th>
              <th>Reviews</th>
              <th>Comments</th>
              <th>Changes</th>
              <th>Merged/Closed</th>
            </tr>
          </thead>
          <tbody>
            ${sortedPRs.map(pr => `
            <tr>
              <td class="pr-number">#${pr.number}</td>
              <td class="pr-title"><a href="${pr.url}" target="_blank" rel="noopener">${escapeHTML(pr.title)}</a></td>
              <td class="author">@${pr.author}</td>
              <td><span class="badge ${pr.merged ? 'merged' : 'closed'}">${pr.merged ? '✓ Merged' : '✕ Closed'}</span></td>
              <td class="mono text-secondary">${pr.cycleTimeDays ? pr.cycleTimeDays + 'd' : '—'}</td>
              <td class="mono text-secondary">${pr.totalReviews || 0}</td>
              <td class="mono text-secondary">${pr.totalComments || 0}</td>
              <td class="mono"><span class="text-green">+${pr.additions}</span> <span class="text-red">-${pr.deletions}</span></td>
              <td class="mono text-muted">${formatDate(pr.mergedAt || pr.closedAt)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </section>

    <footer class="footer">
      <p>Generated by <a href="https://github.com/pr-stats-action">PR Stats Action</a></p>
    </footer>
  </div>
</body>
</html>`;
}

/**
 * Escape HTML special characters
 * @param {string} str - String to escape
 * @returns {string} - Escaped string
 */
function escapeHTML(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Format date for display
 * @param {string} dateStr - ISO date string
 * @returns {string} - Formatted date
 */
function formatDate(dateStr) {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Calculate weekly PR counts for sparkline
 * @param {Array} prs - PR statistics
 * @returns {Array} - Weekly counts (12 weeks)
 */
function calculateWeeklyPRCount(prs) {
  const weeks = Array(12).fill(0);
  const now = new Date();
  
  prs.forEach(pr => {
    const mergedAt = pr.mergedAt ? new Date(pr.mergedAt) : null;
    if (mergedAt) {
      const weeksAgo = Math.floor((now - mergedAt) / (7 * 24 * 60 * 60 * 1000));
      if (weeksAgo >= 0 && weeksAgo < 12) {
        weeks[11 - weeksAgo]++;
      }
    }
  });
  
  return weeks;
}

/**
 * Calculate weekly stats for a metric
 * @param {Array} prs - PR statistics
 * @param {string} metric - Metric name
 * @returns {Array} - Weekly averages
 */
function calculateWeeklyStats(prs, metric) {
  const weeks = Array(12).fill(null).map(() => []);
  const now = new Date();
  
  prs.forEach(pr => {
    const mergedAt = pr.mergedAt ? new Date(pr.mergedAt) : null;
    if (mergedAt && pr[metric]) {
      const weeksAgo = Math.floor((now - mergedAt) / (7 * 24 * 60 * 60 * 1000));
      if (weeksAgo >= 0 && weeksAgo < 12) {
        weeks[11 - weeksAgo].push(pr[metric]);
      }
    }
  });
  
  return weeks.map(w => w.length ? (w.reduce((a, b) => a + b, 0) / w.length) : 0);
}

/**
 * Generate CSV content from PR stats
 * @param {Array} prStats - Individual PR statistics
 * @returns {string} - CSV content
 */
function generateCSV(prStats) {
  const sortedPRs = [...prStats].sort((a, b) => b.number - a.number);
  
  // Define CSV headers
  const headers = [
    'PR Number',
    'Title',
    'Author',
    'Status',
    'Created At',
    'Merged At',
    'Closed At',
    'Cycle Time (Days)',
    'Cycle Time (Hours)',
    'Lead Time (Days)',
    'Lead Time (Hours)',
    'Time to First Review (Days)',
    'Time to First Review (Hours)',
    'Time to Approval (Days)',
    'Time to Approval (Hours)',
    'Total Comments',
    'PR Comments',
    'Inline Comments',
    'Review Threads',
    'Total Reviews',
    'Approvals',
    'Changes Requested',
    'Unique Reviewers',
    'Reviewers',
    'Total Commits',
    'Commits After PR Open',
    'Additions',
    'Deletions',
    'Net Changes',
    'Files Changed',
    'Labels',
    'Base Branch',
    'Head Branch',
    'URL'
  ];
  
  // Build CSV rows
  const rows = sortedPRs.map(pr => [
    pr.number,
    escapeCSV(pr.title),
    escapeCSV(pr.author),
    pr.merged ? 'Merged' : 'Closed',
    pr.createdAt,
    pr.mergedAt || '',
    pr.closedAt || '',
    pr.cycleTimeDays || '',
    pr.cycleTimeHours ? pr.cycleTimeHours.toFixed(2) : '',
    pr.leadTimeDays || '',
    pr.leadTimeHours ? pr.leadTimeHours.toFixed(2) : '',
    pr.timeToFirstReviewDays || '',
    pr.timeToFirstReviewHours ? pr.timeToFirstReviewHours.toFixed(2) : '',
    pr.timeToApprovalDays || '',
    pr.timeToApprovalHours ? pr.timeToApprovalHours.toFixed(2) : '',
    pr.totalComments || 0,
    pr.prComments || 0,
    pr.inlineComments || 0,
    pr.reviewThreads || 0,
    pr.totalReviews || 0,
    pr.approvals || 0,
    pr.changesRequested || 0,
    pr.uniqueReviewers || 0,
    escapeCSV((pr.reviewers || []).join('; ')),
    pr.totalCommits || 0,
    pr.commitsAfterOpen || 0,
    pr.additions || 0,
    pr.deletions || 0,
    pr.netChanges || 0,
    pr.changedFiles || 0,
    escapeCSV((pr.labels || []).join('; ')),
    escapeCSV(pr.baseRef),
    escapeCSV(pr.headRef),
    pr.url
  ]);
  
  // Combine headers and rows
  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.join(','))
  ].join('\n');
  
  return csvContent;
}

/**
 * Parse GitHub repository URL to extract owner and repo name
 * @param {string} url - GitHub repository URL
 * @returns {object} - { owner, repo }
 */
function parseGitHubUrl(url) {
  // Handle various GitHub URL formats:
  // https://github.com/owner/repo
  // https://github.com/owner/repo.git
  // git@github.com:owner/repo.git
  // owner/repo
  
  let match;
  
  // HTTPS URL format
  match = url.match(/github\.com\/([^\/]+)\/([^\/\s\.]+)/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }
  
  // SSH URL format
  match = url.match(/git@github\.com:([^\/]+)\/([^\/\s\.]+)/);
  if (match) {
    return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
  }
  
  // Simple owner/repo format
  match = url.match(/^([^\/]+)\/([^\/\s]+)$/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }
  
  return null;
}

/**
 * Main application function
 */
async function main() {
  // Check if GitHub token is set
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('Error: GITHUB_TOKEN environment variable is not set.');
    console.error('Please create a .env file with your GitHub personal access token.');
    console.error('See .env.example for reference.');
    process.exit(1);
  }

  // Get repository URL from command line argument
  const repoUrl = process.argv[2];
  if (!repoUrl) {
    console.error('Usage: npm start <repository-url>');
    console.error('');
    console.error('Examples:');
    console.error('  npm start https://github.com/owner/repo');
    console.error('  npm start owner/repo');
    process.exit(1);
  }

  // Parse the repository URL
  const parsed = parseGitHubUrl(repoUrl);
  if (!parsed) {
    console.error('Error: Invalid repository URL format.');
    console.error('Expected formats:');
    console.error('  https://github.com/owner/repo');
    console.error('  owner/repo');
    process.exit(1);
  }

  const { owner, repo } = parsed;

  // Initialize GitHub client
  const client = new GitHubGraphQLClient(token);

  try {
    console.log(`\n🔍 Analyzing repository: ${owner}/${repo}\n`);

    // Get repository info
    console.log('Fetching repository information...');
    const repoData = await client.getRepository(owner, repo);

    // Fetch all closed/merged PRs
    console.log('📥 Fetching all closed and merged pull requests...\n');
    const prs = await client.getAllClosedMergedPRs(owner, repo);
    console.log(`\n✅ Fetched ${prs.length} pull requests\n`);

    if (prs.length === 0) {
      console.log('No closed or merged pull requests found in this repository.');
      return;
    }

    // Calculate statistics for each PR
    console.log('📊 Calculating statistics...');
    const prStats = prs.map(pr => calculatePRStats(pr));

    // Calculate aggregate statistics
    const aggregate = aggregateStats(prStats);

    // Generate CSV
    const csv = generateCSV(prStats);
    const csvFilename = `pr-stats-${owner}-${repo}-${new Date().toISOString().split('T')[0]}.csv`;
    await fs.writeFile(csvFilename, csv, 'utf-8');
    console.log(`\n✅ CSV file saved: ${csvFilename}`);

    // Generate HTML report
    const html = generateHTML(prStats, aggregate, owner, repo);
    const htmlFilename = `pr-stats-${owner}-${repo}-${new Date().toISOString().split('T')[0]}.html`;
    await fs.writeFile(htmlFilename, html, 'utf-8');
    console.log(`✅ HTML report saved: ${htmlFilename}`);
    
    console.log(`📊 Contains ${prStats.length} PRs with detailed statistics\n`);

  } catch (error) {
    console.error('Application error:', error.message);
    if (error.stack) {
      console.error('\nStack trace:', error.stack);
    }
    process.exit(1);
  }
}

// Run the application
main();
