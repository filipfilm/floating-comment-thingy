package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

var (
	hub      *Hub
	upgrader = websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		CheckOrigin:     func(r *http.Request) bool { return true }, // allow all origins for dev
	}
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)
	log.Println("Starting FCT backend server…")

	// ── Database ────────────────────────────────────────────────────────
	if err := InitDB(); err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer CloseDB()

	// ── WebSocket hub ──────────────────────────────────────────────────
	hub = NewHub()
	go hub.Run()

	// ── Routes (Go 1.22 enhanced ServeMux) ─────────────────────────────
	mux := http.NewServeMux()

	// Health.
	mux.HandleFunc("GET /api/v1/health", handleHealth)

	// Threads.
	mux.HandleFunc("GET /api/v1/comments", handleGetComments)
	mux.HandleFunc("POST /api/v1/comments", handleCreateThread)
	mux.HandleFunc("PUT /api/v1/comments/{threadId}", handleUpdateThread)
	mux.HandleFunc("DELETE /api/v1/comments/{threadId}", handleDeleteThread)

	// Replies.
	mux.HandleFunc("POST /api/v1/comments/{threadId}/replies", handleCreateReply)
	mux.HandleFunc("PUT /api/v1/comments/{threadId}/replies/{commentId}", handleUpdateReply)
	mux.HandleFunc("DELETE /api/v1/comments/{threadId}/replies/{commentId}", handleDeleteReply)
	mux.HandleFunc("POST /api/v1/comments/{threadId}/replies/{commentId}/reactions", handleToggleReaction)

	// WebSocket.
	mux.HandleFunc("GET /ws", handleWS)

	// ── Server ─────────────────────────────────────────────────────────
	port := os.Getenv("PORT")
	if port == "" {
		port = "8420"
	}
	addr := ":" + port

	srv := &http.Server{
		Addr:         addr,
		Handler:      corsMiddleware(mux),
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown.
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		sig := <-sigCh
		log.Printf("Received signal %v, shutting down…", sig)

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			log.Fatalf("Server shutdown failed: %v", err)
		}
	}()

	log.Printf("Listening on %s", addr)
	if err := srv.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}
	log.Println("Server stopped.")
}

// ───────────────────────────────── Middleware ────────────────────────────────

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Max-Age", "86400")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ───────────────────────────────── Helpers ───────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("Failed to encode JSON response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, ErrorResponse{Error: http.StatusText(status), Message: msg})
}

// broadcastEvent marshals a WSMessage and sends it to all clients subscribed to the repo.
func broadcastEvent(eventType, repoID string, payload interface{}) {
	msg := WSMessage{
		Type:    eventType,
		RepoID:  repoID,
		Payload: payload,
	}
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Failed to marshal broadcast: %v", err)
		return
	}
	hub.BroadcastToRepo(repoID, data)
}

// ───────────────────────────────── Handlers ──────────────────────────────────

func handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"version": "0.1.0",
	})
}

func handleGetComments(w http.ResponseWriter, r *http.Request) {
	repoID := r.URL.Query().Get("repo")
	filePath := r.URL.Query().Get("file")

	if repoID == "" || filePath == "" {
		writeError(w, http.StatusBadRequest, "query params 'repo' and 'file' are required")
		return
	}

	threads, err := GetThreadsByFile(r.Context(), repoID, filePath)
	if err != nil {
		log.Printf("GetThreadsByFile error: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to fetch threads")
		return
	}

	writeJSON(w, http.StatusOK, threads)
}

func handleCreateThread(w http.ResponseWriter, r *http.Request) {
	var req CreateThreadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	if req.RepoID == "" || req.FilePath == "" || req.Author == "" || req.Body == "" {
		writeError(w, http.StatusBadRequest, "repoId, filePath, author, and body are required")
		return
	}

	thread, err := CreateThread(r.Context(), req)
	if err != nil {
		log.Printf("CreateThread error: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to create thread")
		return
	}

	// Broadcast & notify.
	broadcastEvent("comment_created", thread.RepoID, thread)
	DispatchNotifications(req.Author, req.Body, req.FilePath, req.OriginalStartLine)

	writeJSON(w, http.StatusCreated, thread)
}

func handleUpdateThread(w http.ResponseWriter, r *http.Request) {
	threadID := r.PathValue("threadId")

	var req UpdateThreadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	thread, err := UpdateThread(r.Context(), threadID, req)
	if err != nil {
		log.Printf("UpdateThread error: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to update thread")
		return
	}
	if thread == nil {
		writeError(w, http.StatusNotFound, "thread not found")
		return
	}

	// Broadcast appropriate event.
	eventType := "comment_updated"
	switch strings.ToLower(req.Status) {
	case "resolved":
		eventType = "thread_resolved"
	case "orphaned":
		eventType = "thread_orphaned"
	}
	broadcastEvent(eventType, thread.RepoID, thread)

	writeJSON(w, http.StatusOK, thread)
}

func handleDeleteThread(w http.ResponseWriter, r *http.Request) {
	threadID := r.PathValue("threadId")

	// Get thread first for the broadcast.
	thread, err := GetThread(r.Context(), threadID)
	if err != nil {
		log.Printf("GetThread error: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to fetch thread")
		return
	}
	if thread == nil {
		writeError(w, http.StatusNotFound, "thread not found")
		return
	}

	if err := DeleteThread(r.Context(), threadID); err != nil {
		log.Printf("DeleteThread error: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to delete thread")
		return
	}

	broadcastEvent("comment_deleted", thread.RepoID, map[string]string{"threadId": threadID})
	writeJSON(w, http.StatusOK, map[string]string{"deleted": threadID})
}

func handleCreateReply(w http.ResponseWriter, r *http.Request) {
	threadID := r.PathValue("threadId")

	var req CreateCommentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	if req.Author == "" || req.Body == "" {
		writeError(w, http.StatusBadRequest, "author and body are required")
		return
	}

	comment, err := CreateComment(r.Context(), threadID, req)
	if err != nil {
		log.Printf("CreateComment error: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to create reply")
		return
	}
	if comment == nil {
		writeError(w, http.StatusNotFound, "thread not found")
		return
	}

	// Get full thread for broadcast.
	thread, _ := GetThread(r.Context(), threadID)
	if thread != nil {
		broadcastEvent("comment_created", thread.RepoID, thread)
		DispatchNotifications(req.Author, req.Body, thread.FilePath, thread.OriginalStartLine)
	}

	writeJSON(w, http.StatusCreated, comment)
}

func handleUpdateReply(w http.ResponseWriter, r *http.Request) {
	threadID := r.PathValue("threadId")
	commentID := r.PathValue("commentId")

	var req UpdateCommentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	if req.Body == "" {
		writeError(w, http.StatusBadRequest, "body is required")
		return
	}

	comment, err := UpdateComment(r.Context(), threadID, commentID, req)
	if err != nil {
		log.Printf("UpdateComment error: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to update reply")
		return
	}
	if comment == nil {
		writeError(w, http.StatusNotFound, "comment not found")
		return
	}

	thread, _ := GetThread(r.Context(), threadID)
	if thread != nil {
		broadcastEvent("comment_updated", thread.RepoID, thread)
	}

	writeJSON(w, http.StatusOK, comment)
}

func handleDeleteReply(w http.ResponseWriter, r *http.Request) {
	threadID := r.PathValue("threadId")
	commentID := r.PathValue("commentId")

	// Get thread for broadcast before deleting.
	thread, _ := GetThread(r.Context(), threadID)

	deleted, err := DeleteComment(r.Context(), threadID, commentID)
	if err != nil {
		log.Printf("DeleteComment error: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to delete reply")
		return
	}
	if !deleted {
		writeError(w, http.StatusNotFound, "comment not found")
		return
	}

	if thread != nil {
		broadcastEvent("comment_deleted", thread.RepoID, map[string]string{
			"threadId":  threadID,
			"commentId": commentID,
		})
	}

	writeJSON(w, http.StatusOK, map[string]string{"deleted": commentID})
}

func handleToggleReaction(w http.ResponseWriter, r *http.Request) {
	threadID := r.PathValue("threadId")
	commentID := r.PathValue("commentId")

	var req struct {
		Label  string `json:"label"`
		Author string `json:"author"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	if err := ToggleReaction(r.Context(), threadID, commentID, req.Label, req.Author); err != nil {
		log.Printf("ToggleReaction error: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to toggle reaction")
		return
	}

	thread, _ := GetThread(r.Context(), threadID)
	if thread != nil {
		broadcastEvent("comment_updated", thread.RepoID, thread)
	}

	writeJSON(w, http.StatusOK, map[string]string{"toggled": "true"})
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	repoID := r.URL.Query().Get("repo")
	if repoID == "" {
		writeError(w, http.StatusBadRequest, "query param 'repo' is required")
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WS upgrade error: %v", err)
		return
	}

	client := &Client{
		hub:    hub,
		conn:   conn,
		send:   make(chan []byte, 256),
		repoID: repoID,
	}

	hub.register <- client

	go client.writePump()
	go client.readPump()
}
