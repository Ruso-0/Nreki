/**
 * Type declarations for sql.js.
 * sql.js exposes SQLite compiled to WASM with a synchronous API
 * once initialized (init is async).
 */

declare module "sql.js" {
    export interface SqlJsStatic {
        Database: {
            new(): Database;
            new(data?: ArrayLike<number> | Buffer | null): Database;
        };
    }

    export interface QueryExecResult {
        columns: string[];
        values: any[][];
    }

    export interface Statement {
        bind(params?: any[]): boolean;
        step(): boolean;
        getAsObject(params?: any): Record<string, any>;
        get(params?: any[]): any[];
        free(): boolean;
        reset(): void;
        run(params?: any[]): void;
    }

    export interface Database {
        run(sql: string, params?: any[]): Database;
        exec(sql: string, params?: any[]): QueryExecResult[];
        prepare(sql: string): Statement;
        export(): Uint8Array;
        close(): void;
        getRowsModified(): number;
    }

    export default function initSqlJs(config?: {
        locateFile?: (file: string) => string;
    }): Promise<SqlJsStatic>;
}
