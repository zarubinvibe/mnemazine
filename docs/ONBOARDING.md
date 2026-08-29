# Onboarding

This walkthrough assumes you have never run a local knowledge system before. Every step says what to do and what you should see afterwards.

The short path is the guided one: open the project in Claude Code and run `/mnemazine-setup`. Mnemosyne installs herself as a conversation, one question at a time, and installs nothing without your yes. Below is the same road on foot.

You need Node.js 20 or newer, Python 3.11 or newer, and git. A Mac is recommended, because local recognition of screenshots uses Apple Vision and exists only there. On Linux everything else still works.

1. **Get the project into one folder.**

   ```bash
   git clone https://github.com/zarubinvibe/mnemazine.git "$HOME/Desktop/Mnemazine"
   cd "$HOME/Desktop/Mnemazine"
   ```

   You see the folder appear and your prompt inside it.

2. **Look at the plan before anything is written.**

   ```bash
   MNEMAZINE_SETUP_DRYRUN=1 bash setup.sh
   ```

   You see what the setup would do. Nothing is installed, nothing is moved.

3. **Run the guided setup.**

   ```bash
   bash setup.sh
   ```

   You are asked where the inbox goes and whether you want the Telegram bot. Local engines report honestly: a missing one prints a degraded line instead of pretending to be installed.

4. **Check the state.**

   ```bash
   npm run doctor
   ```

   You see green, or a red line together with the command that fixes it. Exit code 0 means all green, 2 means it works with reduced capabilities, 1 means something failed.

5. **Put real material into the inbox.** Screenshots, PDFs, a saved article, a voice note. Five to ten of your own files, not a toy example.

   You see them sitting in one folder, waiting.

6. **Run the pipeline and watch the stages.** The guard takes a snapshot and hashes every file, local engines read them, facts get a source, long material is cut into separate notes, and each note lands in its section.

   You see notes appear under `vault/`, each with a title you can read and a source you can check.

7. **Open the vault as an Obsidian vault.** Point Obsidian at `vault/`.

   You see the sections, the links between notes, and the block that says how a note helps you.

8. **Try the same file twice.** Put a file you already processed back into the inbox.

   You see it recognised by its hash and skipped. A duplicate costs zero model tokens: that is where the saving comes from.

9. **Read the weekly brief.** It lists what changed and what deserves your time, so the knowledge comes back to you instead of waiting to be remembered.

10. **Decide about deep mode consciously.** With it off, a run costs nothing and material never leaves the machine. With it on, content goes to the model provider you chose. The answer is yours and it is asked, never assumed.

## Keeping it current

Later, when a new version is published, do not clone it again: open the project in Claude Code and run `/mnemazine-update`. It shows what changed first, pulls only fast-forward changes, leaves your settings and your data alone, and re-checks itself afterwards.

## If this helped

If Mnemazine turned your pile into something you actually reuse, give it a star: [https://github.com/zarubinvibe/mnemazine](https://github.com/zarubinvibe/mnemazine). It takes a second and decides whether other people ever find the project.

You have run it end to end, which makes you the person who can improve it. The path is short: fork the repository, create a branch, commit your change, push the branch, then open a Pull Request. Do not push directly to `main`; the release gate rejects it.

Found a step that lies? Open an issue at [https://github.com/zarubinvibe/mnemazine/issues](https://github.com/zarubinvibe/mnemazine/issues) and say what you ran and what you saw.
