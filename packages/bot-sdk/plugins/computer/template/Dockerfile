# The Computer's template: Debian with Screens (Xvfb, x11vnc, noVNC, Chromium) and no desktop. The SDK
# expects /home/user, bash and tar, and the Screens expect `ai-chat-screen`.
# The directory name is not the template's name: the build command (see the SDK README) gives it the
# versioned name that Hosts pass to e2bProvider, for example ai-chat-computer-v3. Change that name
# with every change here, so every Computer is rebuilt on its next wake. Build it with 1536 MiB of
# memory: four Screens fit (about 215 MiB each), and 2048 MiB does not build on the local Embed.
FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git jq tar gzip unzip zip python3 procps fonts-dejavu-core \
    xvfb x11vnc novnc websockify python3-jwcrypto xdotool scrot x11-utils chromium \
  && rm -rf /var/lib/apt/lists/*

COPY ai-chat-screen /usr/local/bin/ai-chat-screen
RUN chmod +x /usr/local/bin/ai-chat-screen
