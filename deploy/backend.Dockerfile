FROM rust:1.98.1-bookworm AS build
WORKDIR /app
COPY backend/Cargo.toml backend/Cargo.lock ./
# Compile dependencies independently of application sources. Both targets mirror
# this package's implicit lib/bin targets; clean only this package afterwards so
# placeholder artifacts can never be reused as the delivered application.
RUN mkdir src \
    && printf 'fn main() {}\n' > src/main.rs \
    && touch src/lib.rs \
    && cargo build --locked --release \
    && cargo clean --release --package backend \
    && rm -rf src
COPY backend/src ./src
COPY backend/migrations ./migrations
RUN cargo build --locked --release

FROM debian:bookworm-slim
RUN groupadd --gid 10001 filehop && useradd --uid 10001 --gid filehop --no-create-home filehop
COPY --from=build /app/target/release/backend /usr/local/bin/filehop
USER filehop
EXPOSE 8080
ENTRYPOINT ["filehop"]
CMD ["serve"]
