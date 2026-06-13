package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

var db *sql.DB

// InitDB opens (or creates) the SQLite database and runs migrations.
func InitDB() error {
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "./data"
	}

	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return fmt.Errorf("create data dir: %w", err)
	}

	dbPath := filepath.Join(dataDir, "fct.db")
	log.Printf("Opening database at %s", dbPath)

	var err error
	db, err = sql.Open("sqlite", dbPath+"?_pragma=busy_timeout(5000)")
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}

	// Enable WAL mode for better concurrent read performance.
	if _, err := db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		return fmt.Errorf("enable WAL: %w", err)
	}

	// Foreign keys on.
	if _, err := db.Exec("PRAGMA foreign_keys=ON"); err != nil {
		return fmt.Errorf("enable foreign keys: %w", err)
	}

	if err := migrate(); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}

	// Reasonable pool settings for an embedded DB.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)

	return nil
}

func migrate() error {
	ddl := `
	CREATE TABLE IF NOT EXISTS repositories (
		id   TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		url  TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL DEFAULT (strftime('%%Y-%%m-%%dT%%H:%%M:%%SZ','now'))
	);

	CREATE TABLE IF NOT EXISTS threads (
		id                  TEXT PRIMARY KEY,
		repo_id             TEXT NOT NULL,
		file_path           TEXT NOT NULL,
		commit_hash         TEXT NOT NULL DEFAULT '',
		branch_name         TEXT NOT NULL DEFAULT '',
		original_start_line INTEGER NOT NULL,
		original_end_line   INTEGER NOT NULL,
		code_snippet        TEXT NOT NULL DEFAULT '',
		status              TEXT NOT NULL DEFAULT 'active',
		created_at          TEXT NOT NULL,
		updated_at          TEXT NOT NULL,
		FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
	);

	CREATE INDEX IF NOT EXISTS idx_threads_repo_file ON threads(repo_id, file_path);
	CREATE INDEX IF NOT EXISTS idx_threads_status     ON threads(status);

	CREATE TABLE IF NOT EXISTS comments (
		id         TEXT PRIMARY KEY,
		thread_id  TEXT NOT NULL,
		author     TEXT NOT NULL,
		body       TEXT NOT NULL,
		mentions   TEXT NOT NULL DEFAULT '[]',
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
	);

	CREATE INDEX IF NOT EXISTS idx_comments_thread ON comments(thread_id);
	`
	_, err := db.Exec(ddl)
	if err != nil {
		return err
	}

	// Migrations for character precision (added in v0.2.0)
	// Safe to run multiple times because SQLite will just error if column exists. We ignore the error.
	_, _ = db.Exec(`ALTER TABLE threads ADD COLUMN original_start_char INTEGER NOT NULL DEFAULT 0;`)
	_, _ = db.Exec(`ALTER TABLE threads ADD COLUMN original_end_char INTEGER NOT NULL DEFAULT 0;`)

	// Migrations for reactions (added in v0.3.0)
	_, _ = db.Exec(`ALTER TABLE comments ADD COLUMN reactions TEXT NOT NULL DEFAULT '[]';`)

	return nil
}

// CloseDB shuts down the database connection.
func CloseDB() {
	if db != nil {
		_ = db.Close()
	}
}

// ---------- Repository helpers ----------

// EnsureRepo creates a repository row if it doesn't exist.
func EnsureRepo(ctx context.Context, repoID string) error {
	_, err := db.ExecContext(ctx,
		`INSERT OR IGNORE INTO repositories (id, name) VALUES (?, ?)`,
		repoID, repoID,
	)
	return err
}

// ---------- Thread CRUD ----------

// CreateThread inserts a new thread with an initial comment.
func CreateThread(ctx context.Context, req CreateThreadRequest) (*Thread, error) {
	if err := EnsureRepo(ctx, req.RepoID); err != nil {
		return nil, fmt.Errorf("ensure repo: %w", err)
	}

	now := time.Now().UTC()
	threadID := uuid.New().String()
	commentID := uuid.New().String()

	mentions := ParseMentions(req.Body)
	mentionsJSON, _ := json.Marshal(mentions)

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback() //nolint:errcheck

	_, err = tx.ExecContext(ctx, `
		INSERT INTO threads (id, repo_id, file_path, commit_hash, branch_name,
			original_start_line, original_start_char, original_end_line, original_end_char, code_snippet, status, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
		threadID, req.RepoID, req.FilePath, req.CommitHash, req.BranchName,
		req.OriginalStartLine, req.OriginalStartChar, req.OriginalEndLine, req.OriginalEndChar, req.CodeSnippet,
		now.Format(time.RFC3339), now.Format(time.RFC3339),
	)
	if err != nil {
		return nil, fmt.Errorf("insert thread: %w", err)
	}

	_, err = tx.ExecContext(ctx, `
		INSERT INTO comments (id, thread_id, author, body, mentions, reactions, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		commentID, threadID, req.Author, req.Body, string(mentionsJSON), "[]",
		now.Format(time.RFC3339), now.Format(time.RFC3339),
	)
	if err != nil {
		return nil, fmt.Errorf("insert comment: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	thread := &Thread{
		ID:                threadID,
		RepoID:            req.RepoID,
		FilePath:          req.FilePath,
		CommitHash:        req.CommitHash,
		BranchName:        req.BranchName,
		OriginalStartLine: req.OriginalStartLine,
		OriginalStartChar: req.OriginalStartChar,
		OriginalEndLine:   req.OriginalEndLine,
		OriginalEndChar:   req.OriginalEndChar,
		CodeSnippet:       req.CodeSnippet,
		Status:            "active",
		CreatedAt:         now,
		UpdatedAt:         now,
		Comments: []Comment{
			{
				ID:        commentID,
				ThreadID:  threadID,
				Author:    req.Author,
				Body:      req.Body,
				Mentions:  mentions,
				Reactions: []Reaction{},
				CreatedAt: now,
				UpdatedAt: now,
			},
		},
	}
	return thread, nil
}

// GetThreadsByFile returns all threads (with comments) for a given repo + file path.
func GetThreadsByFile(ctx context.Context, repoID, filePath string) ([]Thread, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT id, repo_id, file_path, commit_hash, branch_name,
			original_start_line, original_start_char, original_end_line, original_end_char, code_snippet, status,
			created_at, updated_at
		FROM threads
		WHERE repo_id = ? AND file_path = ?
		ORDER BY created_at ASC`, repoID, filePath)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var threads []Thread
	for rows.Next() {
		var t Thread
		var createdAt, updatedAt string
		if err := rows.Scan(&t.ID, &t.RepoID, &t.FilePath, &t.CommitHash,
			&t.BranchName, &t.OriginalStartLine, &t.OriginalStartChar, &t.OriginalEndLine, &t.OriginalEndChar,
			&t.CodeSnippet, &t.Status, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		t.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
		t.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAt)
		t.Comments = []Comment{} // initialize so JSON encodes as [] not null
		threads = append(threads, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Batch-load comments for all threads.
	for i := range threads {
		comments, err := getCommentsByThread(ctx, threads[i].ID)
		if err != nil {
			return nil, err
		}
		threads[i].Comments = comments
	}

	if threads == nil {
		threads = []Thread{}
	}
	return threads, nil
}

// GetThread returns a single thread by ID with its comments.
func GetThread(ctx context.Context, threadID string) (*Thread, error) {
	var t Thread
	var createdAt, updatedAt string
	err := db.QueryRowContext(ctx, `
		SELECT id, repo_id, file_path, commit_hash, branch_name,
			original_start_line, original_start_char, original_end_line, original_end_char, code_snippet, status,
			created_at, updated_at
		FROM threads WHERE id = ?`, threadID).Scan(
		&t.ID, &t.RepoID, &t.FilePath, &t.CommitHash,
		&t.BranchName, &t.OriginalStartLine, &t.OriginalStartChar, &t.OriginalEndLine, &t.OriginalEndChar,
		&t.CodeSnippet, &t.Status, &createdAt, &updatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	t.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	t.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAt)

	t.Comments, err = getCommentsByThread(ctx, t.ID)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// UpdateThread patches thread fields (status, line numbers).
func UpdateThread(ctx context.Context, threadID string, req UpdateThreadRequest) (*Thread, error) {
	now := time.Now().UTC()

	// Build dynamic SET clause.
	sets := []string{"updated_at = ?"}
	args := []interface{}{now.Format(time.RFC3339)}

	if req.Status != "" {
		sets = append(sets, "status = ?")
		args = append(args, req.Status)
	}
	if req.OriginalStartLine != nil {
		sets = append(sets, "original_start_line = ?")
		args = append(args, *req.OriginalStartLine)
	}
	if req.OriginalEndLine != nil {
		sets = append(sets, "original_end_line = ?")
		args = append(args, *req.OriginalEndLine)
	}

	query := fmt.Sprintf("UPDATE threads SET %s WHERE id = ?",
		joinStrings(sets, ", "))
	args = append(args, threadID)

	res, err := db.ExecContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, nil
	}

	return GetThread(ctx, threadID)
}

// DeleteThread removes a thread and its comments (cascade).
func DeleteThread(ctx context.Context, threadID string) error {
	_, err := db.ExecContext(ctx, `DELETE FROM threads WHERE id = ?`, threadID)
	return err
}

// ---------- Comment CRUD ----------

func getCommentsByThread(ctx context.Context, threadID string) ([]Comment, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT id, thread_id, author, body, mentions, reactions, created_at, updated_at
		FROM comments WHERE thread_id = ?
		ORDER BY created_at ASC`, threadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	comments := []Comment{}
	for rows.Next() {
		var c Comment
		var mentionsJSON, reactionsJSON, createdAt, updatedAt string
		if err := rows.Scan(&c.ID, &c.ThreadID, &c.Author, &c.Body,
			&mentionsJSON, &reactionsJSON, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		c.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
		c.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAt)
		_ = json.Unmarshal([]byte(mentionsJSON), &c.Mentions)
		if c.Mentions == nil {
			c.Mentions = []string{}
		}
		_ = json.Unmarshal([]byte(reactionsJSON), &c.Reactions)
		if c.Reactions == nil {
			c.Reactions = []Reaction{}
		}
		comments = append(comments, c)
	}
	return comments, rows.Err()
}

// CreateComment adds a reply to a thread.
func CreateComment(ctx context.Context, threadID string, req CreateCommentRequest) (*Comment, error) {
	// Verify thread exists.
	t, err := GetThread(ctx, threadID)
	if err != nil {
		return nil, err
	}
	if t == nil {
		return nil, nil
	}

	now := time.Now().UTC()
	commentID := uuid.New().String()
	mentions := ParseMentions(req.Body)
	mentionsJSON, _ := json.Marshal(mentions)

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback() //nolint:errcheck

	_, err = tx.ExecContext(ctx, `
		INSERT INTO comments (id, thread_id, author, body, mentions, reactions, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		commentID, threadID, req.Author, req.Body, string(mentionsJSON), "[]",
		now.Format(time.RFC3339), now.Format(time.RFC3339),
	)
	if err != nil {
		return nil, err
	}

	// Touch parent thread.
	_, err = tx.ExecContext(ctx,
		`UPDATE threads SET updated_at = ? WHERE id = ?`,
		now.Format(time.RFC3339), threadID,
	)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	return &Comment{
		ID:        commentID,
		ThreadID:  threadID,
		Author:    req.Author,
		Body:      req.Body,
		Mentions:  mentions,
		Reactions: []Reaction{},
		CreatedAt: now,
		UpdatedAt: now,
	}, nil
}

func ToggleReaction(ctx context.Context, threadID, commentID, label, author string) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck

	var reactionsJSON string
	err = tx.QueryRowContext(ctx, "SELECT reactions FROM comments WHERE id = ? AND thread_id = ?", commentID, threadID).Scan(&reactionsJSON)
	if err != nil {
		return err
	}

	var reactions []Reaction
	_ = json.Unmarshal([]byte(reactionsJSON), &reactions)

	foundReaction := false
	for i, r := range reactions {
		if r.Label == label {
			foundReaction = true
			foundAuthor := false
			for j, a := range r.Authors {
				if a == author {
					// Remove author
					reactions[i].Authors = append(reactions[i].Authors[:j], reactions[i].Authors[j+1:]...)
					foundAuthor = true
					break
				}
			}
			if !foundAuthor {
				// Add author
				reactions[i].Authors = append(reactions[i].Authors, author)
			}
			break
		}
	}

	if !foundReaction {
		reactions = append(reactions, Reaction{
			Label:   label,
			Authors: []string{author},
		})
	}

	// Filter out reactions with 0 authors
	var finalReactions []Reaction
	for _, r := range reactions {
		if len(r.Authors) > 0 {
			finalReactions = append(finalReactions, r)
		}
	}
	if finalReactions == nil {
		finalReactions = []Reaction{}
	}

	newReactionsJSON, _ := json.Marshal(finalReactions)
	now := time.Now().UTC()

	_, err = tx.ExecContext(ctx, "UPDATE comments SET reactions = ?, updated_at = ? WHERE id = ? AND thread_id = ?", string(newReactionsJSON), now.Format(time.RFC3339), commentID, threadID)
	if err != nil {
		return err
	}

	_, err = tx.ExecContext(ctx, "UPDATE threads SET updated_at = ? WHERE id = ?", now.Format(time.RFC3339), threadID)
	if err != nil {
		return err
	}

	return tx.Commit()
}

// UpdateComment edits a comment body.
func UpdateComment(ctx context.Context, threadID, commentID string, req UpdateCommentRequest) (*Comment, error) {
	now := time.Now().UTC()
	mentions := ParseMentions(req.Body)
	mentionsJSON, _ := json.Marshal(mentions)

	res, err := db.ExecContext(ctx, `
		UPDATE comments SET body = ?, mentions = ?, updated_at = ?
		WHERE id = ? AND thread_id = ?`,
		req.Body, string(mentionsJSON), now.Format(time.RFC3339),
		commentID, threadID,
	)
	if err != nil {
		return nil, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, nil
	}

	// Touch parent thread.
	_, _ = db.ExecContext(ctx,
		`UPDATE threads SET updated_at = ? WHERE id = ?`,
		now.Format(time.RFC3339), threadID,
	)

	var c Comment
	var mJSON, createdAt, updatedAt string
	err = db.QueryRowContext(ctx, `
		SELECT id, thread_id, author, body, mentions, created_at, updated_at
		FROM comments WHERE id = ?`, commentID).Scan(
		&c.ID, &c.ThreadID, &c.Author, &c.Body, &mJSON, &createdAt, &updatedAt,
	)
	if err != nil {
		return nil, err
	}
	c.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	c.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAt)
	_ = json.Unmarshal([]byte(mJSON), &c.Mentions)
	if c.Mentions == nil {
		c.Mentions = []string{}
	}
	return &c, nil
}

// DeleteComment removes a single comment.
func DeleteComment(ctx context.Context, threadID, commentID string) (bool, error) {
	res, err := db.ExecContext(ctx,
		`DELETE FROM comments WHERE id = ? AND thread_id = ?`,
		commentID, threadID,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// joinStrings joins a slice of strings with a separator (avoids importing strings pkg just for Join).
func joinStrings(elems []string, sep string) string {
	if len(elems) == 0 {
		return ""
	}
	result := elems[0]
	for _, e := range elems[1:] {
		result += sep + e
	}
	return result
}
