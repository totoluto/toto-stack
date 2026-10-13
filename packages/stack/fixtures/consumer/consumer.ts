// Type-level consumer test: compiled against the BUILT package (dist d.ts) by dist.test.ts.
import type {SessionData} from "express-session";
import {BaseRoute, createServer, Role} from "toto-stack";
import type {Dependencies, Request, Response, StackConfig} from "toto-stack";

class Greeter {
    greet(name: string): string {
        return `hi ${name}`;
    }
}

declare module "toto-stack" {
    interface CustomServices {
        greeter: Greeter;
    }
}

export class HelloRoute extends BaseRoute {
    constructor(dependencies: Dependencies) {
        super("/hello", dependencies, {roles: [Role.ADMIN, "editor"]});
    }

    protected registerRoutes(): void {
        this.get("/", (req: Request, res: Response) => {
            // Express.Request augmentation survives in the d.ts
            const id: number | undefined = req.user?.id;
            // CustomServices are merged into Dependencies
            res.json({message: this.dependencies.greeter.greet("x"), id});
        });
    }
}

// @ts-expect-error unknown dependencies are still errors
export const missing = (dependencies: Dependencies) => dependencies.notAService;

declare const prisma: StackConfig["prisma"];
createServer({prisma, routes: [HelloRoute], services: () => ({greeter: new Greeter()})});
// @ts-expect-error the services factory must return the augmented CustomServices
createServer({prisma, services: () => ({})});

// express-session augmentation survives in the d.ts
export const token: SessionData["csrfToken"] = "token";
