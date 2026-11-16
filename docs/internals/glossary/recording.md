# Glossary: Recording

- **Background recording.** The always-on, low-cost parent-process capture of requests and response bodies, used when DevTools was not open.
- **Exchange.** One request and its response, from the channel opening to its one log line. Its id is the run plus the channel id.
- **Run.** One browser session, start to quit. Every file a run writes carries its run id, and channel ids repeat across runs.
- **Site.** The registrable domain of the top-level document, or the host for IP and single-label hosts. Recording, exclusion and history group by it.
- **Site directory.** A site's folder under `sites/`. A site name too long for one directory name is cut with a hash and cannot be read back, so recovery links files to their site directory, never to the site.
- **Body route.** The row of `BODY_ROUTES` that decides, from the response head alone, whether a body is copied and into which sink.
- **Sink.** Where a copied body goes while it arrives: a memory tee into the site's pack, or a file tee into `incoming/`.
- **Pack.** A site's append-only file of small bodies for one run, addressed by offset and length.
- **Part.** A file tee's file in `incoming/` while its body arrives. It becomes a body file when the tee closes.
- **Log segment.** A site's append-only file of exchange lines for one run, sealed by size, idle time or quit. The newline is the commit point.
- **Segment summary.** A segment's counts and activity buckets, written through a `.tmp` file and a rename. It counts only while its size matches the segment's.
- **Exclusion.** A site the user stopped recording. Its directory is deleted, and recovery finishes a deletion a crash interrupted.
- **Recovery.** The plan the next start makes from what is on disk after a crash. Planning again after it runs plans nothing.
- **Retention.** Deleting the oldest sealed files when the archive passes its size or age cap. It stops at a file an export has pinned.
- **Activity index.** The in-memory counts behind the popup and history pages, derived from summaries and open segments and never written to disk.
