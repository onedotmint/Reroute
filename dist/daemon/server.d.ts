import { Coordinator } from '../core/coordinator.js';
export declare function serve(coordinator?: Coordinator): Promise<{
    close: () => Promise<void>;
}>;
