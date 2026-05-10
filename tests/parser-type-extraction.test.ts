import { beforeAll, describe, expect, it } from "vitest";
import { ASTParser } from "../src/parser.js";
import { extractTypeIO } from "../src/utils/type-extractor.js";

describe("parser type I/O extraction (sub-sprint 2.2)", () => {
    let parser: ASTParser;

    beforeAll(async () => {
        parser = new ASTParser();
        await parser.initialize();
    });

    async function parseFirstChunk(code: string, file = "fixture.ts") {
        const result = await parser.parse(file, code);
        expect(result.chunks.length).toBeGreaterThan(0);
        return result.chunks[0];
    }

    async function parseChunkBySymbol(code: string, symbolName: string, file = "fixture.ts") {
        const result = await parser.parse(file, code);
        const chunk = result.chunks.find((c) => c.symbolName === symbolName);
        expect(chunk, `chunk "${symbolName}" not found among [${result.chunks.map(c => c.symbolName).join(", ")}]`).toBeDefined();
        return chunk!;
    }

    it("(a) Result<T> unwraps to T (Result in expanded UNWRAP)", async () => {
        const chunk = await parseFirstChunk(
            "function processOrder(order: Order): Result<Invoice> { return null as any; }"
        );
        expect(chunk.consumes).toEqual(["Order"]);
        expect(chunk.produces).toEqual(["Invoice"]);
    });

    it("(b) Promise<User[]> unwraps to User", async () => {
        const chunk = await parseFirstChunk(
            "async function fetchUsers(): Promise<User[]> { return []; }"
        );
        expect(chunk.consumes).toEqual([]);
        expect(chunk.produces).toEqual(["User"]);
    });

    it("(c) any/void are discarded", async () => {
        const chunk = await parseFirstChunk(
            "function noop(x: any): void { return; }"
        );
        expect(chunk.consumes).toEqual([]);
        expect(chunk.produces).toEqual([]);
    });

    it("(d) class method: Promise<void> produces nothing", async () => {
        const chunk = await parseChunkBySymbol(
            "class Repo { save(item: Item): Promise<void> { return Promise.resolve(); } }",
            "save",
        );
        expect(chunk.nodeType).toBe("method");
        expect(chunk.consumes).toEqual(["Item"]);
        expect(chunk.produces).toEqual([]);
    });

    it("(e) nested generic Promise<Map<string,User>> reduces to Map (documented regex gap)", async () => {
        const chunk = await parseFirstChunk(
            "function f(): Promise<Map<string, User>> { return new Map(); }"
        );
        expect(chunk.produces).toEqual(["Map"]);
    });

    it("(f) Either kept as container; Option<User> unwraps to User", async () => {
        const chunk = await parseFirstChunk(
            "function h(e: Either<Error, Token>): Option<User> { return null as any; }"
        );
        expect(chunk.consumes).toEqual(["Either"]);
        expect(chunk.produces).toEqual(["User"]);
    });

    it("(g) non-callable nodes (class) leave consumes/produces undefined", async () => {
        const chunk = await parseChunkBySymbol(
            "class MyClass { }",
            "MyClass",
        );
        expect(chunk.nodeType).toBe("class");
        expect(chunk.consumes).toBeUndefined();
        expect(chunk.produces).toBeUndefined();
    });
});

describe("Sub-sprint 2.2.2.2: reserved words filtering", () => {
    const reserved = [
        "typeof", "asserts", "keyof", "infer",
        "extends", "is", "in", "as",
        "satisfies", "readonly",
    ];

    it.each(reserved)("discards reserved word '%s' from consumes", (token) => {
        const result = extractTypeIO(`function f(x: ${token}): void {}`);
        expect(result.consumes).not.toContain(token);
    });
});

describe("Sub-sprint 2.2.2.2: single-letter generic filtering", () => {
    it("discards single-letter T from consumes and produces", () => {
        const result = extractTypeIO("function f<T>(x: T): T {}");
        expect(result.consumes).not.toContain("T");
        expect(result.produces).not.toContain("T");
    });

    it("discards single-letter K, V, R", () => {
        const r1 = extractTypeIO("function f(x: K): V {}");
        expect(r1.consumes).not.toContain("K");
        expect(r1.produces).not.toContain("V");
        const r2 = extractTypeIO("function g(x: P): R {}");
        expect(r2.consumes).not.toContain("P");
        expect(r2.produces).not.toContain("R");
    });

    it("preserves real custom 2-char types (ID, DB)", () => {
        const result = extractTypeIO("function f(x: ID): DB {}");
        expect(result.consumes).toContain("ID");
        expect(result.produces).toContain("DB");
    });

    it("preserves multi-char identifiers", () => {
        const result = extractTypeIO("function f(x: User): Order {}");
        expect(result.consumes).toContain("User");
        expect(result.produces).toContain("Order");
    });
});

describe("Sub-sprint 2.2.2.2: inline object literal handling (structural fix)", () => {
    it("does not emit inline object as type when wrapped in Promise", () => {
        const sample =
            "async function f(): Promise<{ a: string; b: number }> { return null as any; }";
        const result = extractTypeIO(sample);
        for (const t of result.produces) {
            expect(t).not.toMatch(/[{\[\(\n]/);
        }
    });

    it("does not emit union as type when wrapped in Promise", () => {
        const sample = "async function h(): Promise<string[] | Error> { return []; }";
        const result = extractTypeIO(sample);
        for (const t of result.produces) {
            expect(t).not.toMatch(/[{\[\(\n|]/);
            expect(t).not.toMatch(/\s/);
        }
    });

    it("does not emit intersection as type when wrapped in Promise", () => {
        const sample =
            "async function g(): Promise<T & { name: string }> { return null as any; }";
        const result = extractTypeIO(sample);
        for (const t of result.produces) {
            expect(t).not.toMatch(/[{\[\(\n&]/);
        }
    });

    it("control: Promise<User> still unwraps to User", () => {
        const sample = "async function f(): Promise<User> { return null as any; }";
        const result = extractTypeIO(sample);
        expect(result.produces).toContain("User");
    });

    it("Promise<Result<User>> stops at Result (documented regex gap, L11-L13)", () => {
        // TYPE_TOKEN's `<[^>]+>` greedy match captures "Promise<Result<User>"
        // (one '>' short of full nested closure), so recursive unwrap stops
        // at "Result". Sub-sprint 2.2.2.2 preserves this baseline; nested
        // generic depth is a separate concern.
        const sample = "async function f(): Promise<Result<User>> { return null as any; }";
        const result = extractTypeIO(sample);
        expect(result.produces).toContain("Result");
    });

    describe("Sub-sprint 2.2.3: type predicate detection", () => {
        it("zod isPlainObject — does not capture 'o' as produces", () => {
            const result = extractTypeIO(
                "function isPlainObject(o: unknown): o is Record<string, unknown> { return true; }"
            );
            expect(result.produces).not.toContain("o");
            expect(result.produces).not.toContain("Record");
        });

        it("type predicate with single-param subject 'children'", () => {
            const result = extractTypeIO(
                "function isReactNode(children: unknown): children is ReactNode { return true; }"
            );
            expect(result.produces).not.toContain("children");
            expect(result.produces).not.toContain("ReactNode");
        });

        it("preserves regular boolean return type (not predicate)", () => {
            const result = extractTypeIO(
                "function check(x: number): boolean { return x > 0; }"
            );
            // boolean is in DISCARD_NAMES, so produces is empty.
            expect(result.produces).toEqual([]);
        });

        it("preserves type-real return when no predicate", () => {
            const result = extractTypeIO(
                "function getUser(): User { return {} as User; }"
            );
            expect(result.produces).toContain("User");
        });

        it("complex predicate with namespaced type", () => {
            const result = extractTypeIO(
                "function isUser(x: unknown): x is models.User { return true; }"
            );
            // Per Furia regla sagrada Under-Unwrap > Over-Unwrap:
            // even though models.User is a real type, when entire return
            // clause is predicate we discard everything to avoid emitting
            // "x" lowercase as produces.
            expect(result.produces).not.toContain("x");
            expect(result.produces).not.toContain("models");
            expect(result.produces).not.toContain("User");
        });
    });

    describe("Sub-sprint 2.2.2.4: utility types semantic unwrap", () => {
        describe("Tier A: oracle keeps first arg", () => {
            it("Partial<Model> → unwraps to Model", () => {
                const result = extractTypeIO("function f(): Partial<Model> { return null as any; }");
                expect(result.produces).toContain("Model");
                expect(result.produces).not.toContain("Partial");
            });

            it("Required<AstroSettings> → unwraps", () => {
                const result = extractTypeIO("function f(): Required<AstroSettings> { return null as any; }");
                expect(result.produces).toContain("AstroSettings");
            });

            it("Readonly<Config> → unwraps to Config", () => {
                const result = extractTypeIO("function f(x: Readonly<Config>): void {}");
                expect(result.consumes).toContain("Config");
            });

            it("NonNullable<RouteData> → unwraps", () => {
                const result = extractTypeIO("function f(): NonNullable<RouteData> { return null as any; }");
                expect(result.produces).toContain("RouteData");
                expect(result.produces).not.toContain("NonNullable");
            });

            it("Exclude<SSRResult, X> → unwraps to first arg", () => {
                const result = extractTypeIO("function f(): Exclude<SSRResult, string> { return null as any; }");
                expect(result.produces).toContain("SSRResult");
            });

            it("Extract<T, U> → unwraps to first arg", () => {
                const result = extractTypeIO("function f(): Extract<UnionType, BaseType> { return null as any; }");
                expect(result.produces).toContain("UnionType");
            });

            it("Awaited<UserType> → unwraps to UserType (single-level)", () => {
                const result = extractTypeIO("function f(): Awaited<UserType> { return null as any; }");
                expect(result.produces).toContain("UserType");
                expect(result.produces).not.toContain("Awaited");
            });

            it("Awaited<Promise<User>> stops at Promise (documented regex gap 2.2.2.2)", () => {
                // Same regex gap as Promise<Result<User>> below: TYPE_TOKEN's
                // `<[^>]+>` captures one '>' short of full nested closure,
                // so cascade stops at the second level. 2.2.2.4 preserves
                // baseline; nested generic depth is a separate concern.
                const result = extractTypeIO("function f(): Awaited<Promise<User>> { return null as any; }");
                expect(result.produces).toContain("Promise");
            });
        });

        describe("Tier B: oracle drops entirely (mapped types)", () => {
            it("Pick<User, 'id'> → discards entirely", () => {
                const result = extractTypeIO("function f(x: Pick<User, 'id'>): void {}");
                expect(result.consumes).not.toContain("Pick");
            });

            it("Omit<Config, 'secret'> → discards", () => {
                const result = extractTypeIO("function f(): Omit<Config, 'secret'> { return null as any; }");
                expect(result.produces).not.toContain("Omit");
            });

            it("Record<string, Plugin> → discards", () => {
                const result = extractTypeIO("function f(): Record<string, Plugin> { return null as any; }");
                expect(result.produces).not.toContain("Record");
            });
        });

        describe("Tier C: type-level operations (inalcanzable)", () => {
            it("ReturnType<typeof func> → discards", () => {
                const result = extractTypeIO("function f(): ReturnType<typeof getUser> { return null as any; }");
                expect(result.produces).not.toContain("ReturnType");
            });

            it("Parameters<typeof func> → discards", () => {
                const result = extractTypeIO("function f(x: Parameters<typeof handle>): void {}");
                expect(result.consumes).not.toContain("Parameters");
            });

            it("InstanceType<typeof Class> → discards", () => {
                const result = extractTypeIO("function f(): InstanceType<typeof MyClass> { return null as any; }");
                expect(result.produces).not.toContain("InstanceType");
            });

            it("Uppercase<S> string manipulation → discards", () => {
                const result = extractTypeIO("function f(): Uppercase<EventName> { return null as any; }");
                expect(result.produces).not.toContain("Uppercase");
            });
        });

        describe("Edge cases: domain entity collision (accepted casualty)", () => {
            it("user-defined type Record entity is masacred (per Furia)", () => {
                // Caso: usuario define type Record = {...}
                // Trade-off firmado: 60.1% recovery del bucket C
                // justifica masacre de domain entities mal-nombrados.
                // Heurístico DISCARD → [], oracle probable ["Record"]
                // [] ⊆ ["Record"] → Under-Unwrap impecable, NO regresión.
                const result = extractTypeIO("function f(): Record { return null as any; }");
                expect(result.produces).not.toContain("Record");
            });
        });

        describe("Compatibility con Sub-sprint 2.2.2.3 qualified namespace", () => {
            it("t.Pick<X, K> qualified prefix → discards", () => {
                const result = extractTypeIO("function f(): t.Pick<X, 'id'> { return null as any; }");
                expect(result.produces).not.toContain("Pick");
                expect(result.produces).not.toContain("t");
            });
        });
    });

    describe("Sub-sprint 2.2.2.3: qualified namespace F1", () => {
        it("strips namespace prefix in non-generic types", () => {
            const result = extractTypeIO("function f(x: core.Invoice): void {}");
            expect(result.consumes).toContain("Invoice");
            expect(result.consumes).not.toContain("core");
        });

        it("strips namespace inside generic argument", () => {
            const result = extractTypeIO("function f(): Promise<models.User> { return null as any; }");
            expect(result.produces).toContain("User");
            expect(result.produces).not.toContain("models");
        });

        it("strips namespace prefix on whitelisted generic head", () => {
            const result = extractTypeIO("function f(): z.ZodType<string> { return null as any; }");
            expect(result.produces).toContain("ZodType");
            expect(result.produces).not.toContain("z");
        });

        it("handles multi-level qualified namespace", () => {
            const result = extractTypeIO("function f(): types.types.User { return null as any; }");
            expect(result.produces).toContain("User");
            expect(result.produces).not.toContain("types");
        });

        it("preserves non-namespaced single identifiers", () => {
            const result = extractTypeIO("function f(): RuntimeDataModel { return null as any; }");
            expect(result.produces).toContain("RuntimeDataModel");
        });

        it("handles namespace with array brackets", () => {
            const result = extractTypeIO("function f(x: db.User[]): void {}");
            expect(result.consumes).toContain("User");
        });
    });
});

