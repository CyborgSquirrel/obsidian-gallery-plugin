import { App, Modal } from 'obsidian';

/** Ask a yes/no question; resolves true only when the confirm button is pressed (closing says no) */
export function confirmAction(app: App, title: string, message: string, confirmText: string): Promise<boolean> {
    return new Promise(resolve => new ConfirmModal(app, title, message, confirmText, resolve).open());
}

class ConfirmModal extends Modal {
    private answered = false;

    constructor(
        app: App,
        private readonly title: string,
        private readonly message: string,
        private readonly confirmText: string,
        private readonly resolve: (confirmed: boolean) => void
    ) {
        super(app);
    }

    onOpen(): void {
        this.titleEl.setText(this.title);
        this.contentEl.createEl('p', { text: this.message });
        const buttons = this.contentEl.createDiv('modal-button-container');
        buttons.createEl('button', { text: this.confirmText, cls: 'mod-warning' })
            .addEventListener('click', () => this.answer(true));
        buttons.createEl('button', { text: 'Cancel' })
            .addEventListener('click', () => this.answer(false));
    }

    onClose(): void {
        this.contentEl.empty();
        this.answer(false);
    }

    private answer(confirmed: boolean): void {
        if (this.answered) return;
        this.answered = true;
        this.resolve(confirmed);
        this.close();
    }
}
