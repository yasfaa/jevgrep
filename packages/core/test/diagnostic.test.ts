import { test, expect } from "bun:test";
import { parseStackTrace } from "../src/diagnostic";

test("parseStackTrace correctly parses Python tracebacks", () => {
  const pyTrace = `Traceback (most recent call last):
  File "packages/core/src/auth.py", line 45, in authenticate
    token = fetch_token(user_id)
  File "packages/core/src/network.py", line 12, in fetch_token
    raise ZeroDivisionError("division by zero")
ZeroDivisionError: division by zero`;

  const parsed = parseStackTrace(pyTrace);
  expect(parsed.errorName).toBe("ZeroDivisionError");
  expect(parsed.errorMessage).toBe("division by zero");
  expect(parsed.frames.length).toBe(2);
  expect(parsed.frames[0]?.file).toBe("packages/core/src/auth.py");
  expect(parsed.frames[0]?.line).toBe(45);
  expect(parsed.frames[0]?.functionName).toBe("authenticate");
  expect(parsed.frames[1]?.file).toBe("packages/core/src/network.py");
  expect(parsed.frames[1]?.line).toBe(12);
  expect(parsed.frames[1]?.functionName).toBe("fetch_token");
  expect(parsed.suspectFiles).toContain("packages/core/src/auth.py");
  expect(parsed.suspectFiles).toContain("packages/core/src/network.py");
});

test("parseStackTrace correctly parses Node.js V8 stack traces", () => {
  const nodeTrace = `TypeError: Cannot read properties of undefined (reading 'split')
    at parseCommand (D:\\project\\apps\\cli\\src\\args.ts:45:12)
    at main (D:\\project\\apps\\cli\\src\\index.ts:18:20)
    at Object.<anonymous> (D:\\project\\apps\\cli\\src\\index.ts:130:5)`;

  const parsed = parseStackTrace(nodeTrace);
  expect(parsed.errorName).toBe("TypeError");
  expect(parsed.errorMessage).toBe("Cannot read properties of undefined (reading 'split')");
  expect(parsed.frames.length).toBe(3);
  expect(parsed.frames[0]?.functionName).toBe("parseCommand");
  expect(parsed.frames[0]?.line).toBe(45);
  expect(parsed.frames[0]?.column).toBe(12);
});

test("parseStackTrace correctly parses standard PHP stack traces", () => {
  const phpTrace = `Illuminate\\Database\\QueryException: SQLSTATE[42S22]: Column not found: 1054 Unknown column 'status'
#0 /var/www/html/app/Repositories/UserRepository.php(58): Illuminate\\Database\\Connection->runQueryCallback()
#1 /var/www/html/app/Services/UserService.php(32): App\\Repositories\\UserRepository->getActiveUsers()
#2 /var/www/html/app/Http/Controllers/UserController.php(20): App\\Services\\UserService->index()
#3 {main}`;

  const parsed = parseStackTrace(phpTrace);
  expect(parsed.errorName).toBe("Illuminate\\Database\\QueryException");
  expect(parsed.errorMessage).toContain("Column not found: 1054 Unknown column 'status'");
  expect(parsed.frames.length).toBe(3);
  expect(parsed.frames[0]?.file).toBe("/var/www/html/app/Repositories/UserRepository.php");
  expect(parsed.frames[0]?.line).toBe(58);
  expect(parsed.frames[0]?.functionName).toContain("runQueryCallback");
  expect(parsed.frames[1]?.file).toBe("/var/www/html/app/Services/UserService.php");
  expect(parsed.frames[1]?.line).toBe(32);
  expect(parsed.frames[2]?.file).toBe("/var/www/html/app/Http/Controllers/UserController.php");
  expect(parsed.frames[2]?.line).toBe(20);
});

test("parseStackTrace correctly parses Laravel Ignition / Whoops stack traces", () => {
  const laravelTrace = `App\\Exceptions\\OrderProcessingException: Insufficient inventory for product ID 402
at App\\Services\\OrderService->processOrder(Object(App\\Models\\Order)) in app/Services/OrderService.php:84
at App\\Http\\Controllers\\OrderController->store(Object(App\\Http\\Requests\\OrderRequest)) in app/Http/Controllers/OrderController.php:35`;

  const parsed = parseStackTrace(laravelTrace);
  expect(parsed.errorName).toBe("App\\Exceptions\\OrderProcessingException");
  expect(parsed.errorMessage).toBe("Insufficient inventory for product ID 402");
  expect(parsed.frames.length).toBe(2);
  expect(parsed.frames[0]?.file).toBe("app/Services/OrderService.php");
  expect(parsed.frames[0]?.line).toBe(84);
  expect(parsed.frames[0]?.functionName).toContain("processOrder");
  expect(parsed.frames[1]?.file).toBe("app/Http/Controllers/OrderController.php");
  expect(parsed.frames[1]?.line).toBe(35);
  expect(parsed.frames[1]?.functionName).toContain("store");
});
