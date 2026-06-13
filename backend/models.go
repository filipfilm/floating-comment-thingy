package main

import (
	"time"
)

// Thread represents a comment thread anchored to a specific code location.
type Thread struct {
	ID                string    `json:"id"`
	RepoID            string    `json:"repoId"`
	FilePath          string    `json:"filePath"`
	CommitHash        string    `json:"commitHash"`
	BranchName        string    `json:"branchName"`
	OriginalStartLine int       `json:"originalStartLine"`
	OriginalStartChar int       `json:"originalStartChar"`
	OriginalEndLine   int       `json:"originalEndLine"`
	OriginalEndChar   int       `json:"originalEndChar"`
	CodeSnippet       string    `json:"codeSnippet"`
	Status            string    `json:"status"` // active, resolved, orphaned
	CreatedAt         time.Time `json:"createdAt"`
	UpdatedAt         time.Time `json:"updatedAt"`
	Comments          []Comment `json:"comments"`
}

// Comment represents a single comment within a thread.
type Comment struct {
	ID        string     `json:"id"`
	ThreadID  string     `json:"threadId"`
	Author    string     `json:"author"`
	Body      string     `json:"body"`
	Mentions  []string   `json:"mentions"`
	Reactions []Reaction `json:"reactions"`
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
}

// Reaction represents a reaction on a comment.
type Reaction struct {
	Label   string   `json:"label"`
	Authors []string `json:"authors"`
}

// WSMessage is a WebSocket message envelope.
type WSMessage struct {
	Type    string      `json:"type"`
	RepoID  string      `json:"repoId"`
	Payload interface{} `json:"payload"`
}

// CreateThreadRequest is the JSON body for creating a new thread.
type CreateThreadRequest struct {
	RepoID            string `json:"repoId"`
	FilePath          string `json:"filePath"`
	CommitHash        string `json:"commitHash"`
	BranchName        string `json:"branchName"`
	OriginalStartLine int    `json:"originalStartLine"`
	OriginalStartChar int    `json:"originalStartChar"`
	OriginalEndLine   int    `json:"originalEndLine"`
	OriginalEndChar   int    `json:"originalEndChar"`
	CodeSnippet       string `json:"codeSnippet"`
	// First comment
	Author string `json:"author"`
	Body   string `json:"body"`
}

// UpdateThreadRequest is the JSON body for updating a thread.
type UpdateThreadRequest struct {
	Status            string `json:"status,omitempty"`
	OriginalStartLine *int   `json:"originalStartLine,omitempty"`
	OriginalEndLine   *int   `json:"originalEndLine,omitempty"`
}

// CreateCommentRequest is the JSON body for adding a reply.
type CreateCommentRequest struct {
	Author string `json:"author"`
	Body   string `json:"body"`
}

// UpdateCommentRequest is the JSON body for editing a reply.
type UpdateCommentRequest struct {
	Body string `json:"body"`
}

// ErrorResponse is a standard error envelope.
type ErrorResponse struct {
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}
