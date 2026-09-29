{
  description = "codex-chatgpt-web: use ChatGPT Web (including Pro) as native Codex models — CLI daemon and Electron launcher";

  inputs = {
    # Pinned to the nixpkgs revision this packaging was developed against
    # (same pin as llm-agents-nix). Update freely; electron_41 + bun2nix
    # move with nixpkgs-unstable.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs";
    };
    devenv.url = "github:cachix/devenv";
    bun2nix = {
      # https://github.com/nix-community/bun2nix/pull/106
      url = "github:Mic92/bun2nix/fix-structured-attrs-hook";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    inputs@{ self, ... }:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      imports = [ inputs.devenv.flakeModule ];

      perSystem =
        {
          self',
          inputs',
          config,
          system,
          ...
        }:
        let
          pkgs = import inputs.nixpkgs {
            inherit system;
            config = {
              permittedInsecurePackages = [
                "electron-41.10.6"
              ];
            };
          };
          inherit (pkgs) lib;

          # Single source of truth for both packages (mirrors upstream tags:
          # v$version). Read once here instead of once per package.
          version = (builtins.fromJSON (builtins.readFile "${self}/package.json")).version;

          # This repository's own source, trimmed to what the builds read:
          # the runtime trees (src/, launcher/), the browser-helper
          # generator (scripts/), manifests and lockfiles. Local dev
          # droppings (node_modules, dist, release, .launcher-runtime) and
          # untracked files never enter the store.
          src = lib.cleanSourceWith {
            src = self;
            filter =
              path: type:
              let
                rel = lib.removePrefix (toString self + "/") (toString path);
                launcherOk =
                  lib.hasPrefix "launcher/" rel
                  && !lib.hasPrefix "launcher/node_modules/" rel
                  && !lib.hasPrefix "launcher/dist/" rel
                  && !lib.hasPrefix "launcher/release/" rel;
              in
              lib.hasPrefix "src/" rel
              || lib.hasPrefix "scripts/" rel
              || launcherOk
              || builtins.elem rel [
                "src"
                "scripts"
                "launcher"
                "package.json"
                "tsconfig.json"
                "bun.lock"
              ];
          };

          # bun2nix builder set (install hook, fetchBunDeps, ...). Overlaid
          # directly (final = prev = pkgs) instead of pkgs.extend, which
          # would re-run the whole nixpkgs fixpoint for this one leaf.
          bun2nixLib = (inputs.bun2nix.overlays.default pkgs pkgs).bun2nix;
          inherit (inputs'.bun2nix.packages) bun2nix;
        in
        {
          packages =
            (lib.filterAttrs (_: p: lib.meta.availableOn pkgs.stdenv.hostPlatform p) {
              # CLI daemon (src/cli.ts): serve/setup/doctor/MCP/service.
              codex-chatgpt-web-cli = pkgs.callPackage ./nix/codex-chatgpt-web-cli.nix {
                inherit bun2nixLib src version;
              };
              # Electron launcher GUI running the repo unpackaged.
              codex-chatgpt-web = pkgs.callPackage ./nix/codex-chatgpt-web.nix {
                inherit bun2nixLib src version;
              };
            })
            // {
              # The GUI is Linux x86_64-only; keep `.#default` valid on every
              # declared system by falling back to the portable CLI package.
              default =
                if pkgs.stdenv.hostPlatform.system == "x86_64-linux" then
                  self'.packages.codex-chatgpt-web
                else
                  self'.packages.codex-chatgpt-web-cli;
            };
          devenv.shells.default = {
            packages = [
              config.packages.codex-chatgpt-web-cli
              bun2nix
            ];
            tasks."bun2nix:sync" = {
              exec = ''
                ${lib.getExe bun2nix} -l bun.lock -o nix/bun.nix
                ${lib.getExe bun2nix} -l launcher/bun.lock -o nix/bun-launcher.nix
              '';
            };
            scripts.bun2nix-sync.exec = ''
              ${lib.getExe bun2nix} -l bun.lock -o nix/bun.nix
              ${lib.getExe bun2nix} -l launcher/bun.lock -o nix/bun-launcher.nix
            '';
          };
        };
    };
  nixConfig = {
    extra-substituters = [ "https://devenv.cachix.org" ];
    extra-trusted-public-keys = [ "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=" ];
  };
}
