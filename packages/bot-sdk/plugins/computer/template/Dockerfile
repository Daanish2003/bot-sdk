# The Computer's template: plain Debian, no X server. The SDK only expects /home/user, bash and tar.
# The directory name is not the template's name: the build command (see the SDK README) gives it the
# versioned name that Hosts pass to e2bProvider, for example ai-chat-computer-v1. Change that name
# with every change here, so every Computer is rebuilt on its next wake.
FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git jq tar gzip unzip zip python3 \
  && rm -rf /var/lib/apt/lists/*
