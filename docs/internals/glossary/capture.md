# Glossary: Capture

- **DevTools capture.** The request list inside an open DevTools Network panel, exported directly without the built-in panel save dialog.
- **Native tee.** An `nsIStreamListenerTee` attached at examine time that copies a response's wire bytes into a sink as they arrive, without passing them through script.
- **Cap watchdog.** The timer that closes a file tee's part once it reaches the body cap. It runs only while a file tee is live.
- **Archive key.** 128 random bits kept in the profile that name the archive's folder, so no path below the archive root can be guessed.
- **Harness topic.** The observer topic a harness profile turns on to flush, seal, exclude, park the write chain at a crash point, and read recovery.
