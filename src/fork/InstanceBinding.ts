export interface CocosInstance {
    port: number;
    projectName: string;
    projectPath: string;
}

export class InstanceBinding {
    private selected: CocosInstance = null;

    select(port: number, instances: CocosInstance[]): CocosInstance {
        if (!Number.isInteger(port)) {
            return null;
        }
        const instance = instances.find(item => item.port === port);
        if (!instance) {
            return null;
        }
        this.selected = Object.assign({}, instance);
        return this.getSelected();
    }

    reconcile(instances: CocosInstance[]): CocosInstance {
        if (!this.selected) {
            return null;
        }
        const live = instances.find(item => item.port === this.selected.port && item.projectPath === this.selected.projectPath);
        if (!live) {
            this.selected = null;
            return null;
        }
        this.selected = Object.assign({}, live);
        return this.getSelected();
    }

    resolve(instances: CocosInstance[]): CocosInstance {
        const selected = this.reconcile(instances);
        if (selected) {
            return selected;
        }
        if (instances.length === 1) {
            return Object.assign({}, instances[0]);
        }
        return null;
    }

    getSelected(): CocosInstance {
        return this.selected ? Object.assign({}, this.selected) : null;
    }
}
