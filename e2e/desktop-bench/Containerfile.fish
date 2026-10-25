# The bench image plus fish, for the scenarios about shell completion.
#
# The harness image carries bash only, and bash and fish do not complete the same way: fish
# draws its own list, redraws the line it completed, and asks the terminal for nothing. A
# scenario about completion has to run the shell the user runs.
#
# Ubuntu 24.04 ships fish 3.7. The PPA is there because the version matters: fish 4 rewrote
# the terminal handling this bench exists to watch, so a run that means to cover fish 4 has
# to install fish 4 and say so.
#
#   podman build -t localhost/rite-ime-fish:local  -f e2e/desktop-bench/Containerfile.fish \
#     --build-arg FISH=distro e2e/desktop-bench
#   podman build -t localhost/rite-ime-fish4:local -f e2e/desktop-bench/Containerfile.fish \
#     e2e/desktop-bench
#
#   RITE_BENCH_IMAGE=localhost/rite-ime-fish4:local RITE_BENCH_PICK_SHELL=fish \
#     sh e2e/desktop-bench/run.sh tab
FROM localhost/rite-ime:local
ARG FISH=ppa4
RUN if [ "$FISH" = "distro" ]; then \
      apt-get update && apt-get install -y fish; \
    else \
      apt-get update && apt-get install -y software-properties-common \
      && add-apt-repository -y ppa:fish-shell/release-4 \
      && apt-get update && apt-get install -y fish; \
    fi \
 && rm -rf /var/lib/apt/lists/*
