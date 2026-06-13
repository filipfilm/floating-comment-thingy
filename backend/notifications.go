package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"time"
)

var mentionRegex = regexp.MustCompile(`@([a-zA-Z0-9_.-]+)`)

// ParseMentions extracts @username patterns from a comment body.
func ParseMentions(body string) []string {
	matches := mentionRegex.FindAllStringSubmatch(body, -1)
	if len(matches) == 0 {
		return []string{}
	}

	// Deduplicate.
	seen := make(map[string]struct{})
	var result []string
	for _, m := range matches {
		username := m[1]
		if _, ok := seen[username]; !ok {
			seen[username] = struct{}{}
			result = append(result, username)
		}
	}
	return result
}

// BuildDeepLink creates a vscode:// URI that opens a file at a specific line.
func BuildDeepLink(filePath string, line int) string {
	return fmt.Sprintf("vscode://filipdobosz.fct/open?file=%s&line=%d",
		url.QueryEscape(filePath), line)
}

// SendSlackNotification posts a formatted message to a Slack incoming webhook.
func SendSlackNotification(webhookURL, author, body, filePath string, line int, deepLink string) error {
	if webhookURL == "" {
		return nil // silently skip if not configured
	}

	payload := map[string]interface{}{
		"text": fmt.Sprintf("💬 *%s* commented on `%s:%d`\n>%s\n<%s|Open in VS Code>",
			author, filePath, line, body, deepLink),
	}

	return postWebhook(webhookURL, payload)
}

// SendDiscordNotification posts a formatted message to a Discord webhook.
func SendDiscordNotification(webhookURL, author, body, filePath string, line int, deepLink string) error {
	if webhookURL == "" {
		return nil // silently skip if not configured
	}

	payload := map[string]interface{}{
		"content": fmt.Sprintf("💬 **%s** commented on `%s:%d`\n> %s\n[Open in VS Code](%s)",
			author, filePath, line, body, deepLink),
	}

	return postWebhook(webhookURL, payload)
}

// DispatchNotifications sends notifications for a new comment if webhooks are configured.
func DispatchNotifications(author, body, filePath string, line int) {
	deepLink := BuildDeepLink(filePath, line)

	slackURL := os.Getenv("SLACK_WEBHOOK_URL")
	discordURL := os.Getenv("DISCORD_WEBHOOK_URL")

	if slackURL != "" {
		go func() {
			if err := SendSlackNotification(slackURL, author, body, filePath, line, deepLink); err != nil {
				log.Printf("Slack notification failed: %v", err)
			}
		}()
	}

	if discordURL != "" {
		go func() {
			if err := SendDiscordNotification(discordURL, author, body, filePath, line, deepLink); err != nil {
				log.Printf("Discord notification failed: %v", err)
			}
		}()
	}
}

func postWebhook(webhookURL string, payload interface{}) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal webhook payload: %w", err)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Post(webhookURL, "application/json", bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("post webhook: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		return fmt.Errorf("webhook returned status %d", resp.StatusCode)
	}
	return nil
}
