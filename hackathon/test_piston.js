// Piston API Integration & Test Suite
// Executes code via the free, high-performance Piston execution engine (emkc.org)
// Supports C, C++, Java, Python, JavaScript, and C# without requiring local compilers.

const { runPiston, LANGUAGE_CONFIG } = require('./piston');

// Direct test execution if run via `node test_piston.js`
async function runTests() {
  console.log('=============================================');
  console.log('Testing Piston API for All Supported Languages');
  console.log('=============================================\n');

  const testCases = [
    {
      lang: 'javascript',
      name: 'JavaScript - Hello World',
      code: 'console.log("Hello from JavaScript via Piston!");',
      expectOk: true
    },
    {
      lang: 'python',
      name: 'Python 3 - Array Sum',
      code: 'numbers = [1, 2, 3, 4, 5]\nprint("Sum:", sum(numbers))',
      expectOk: true
    },
    {
      lang: 'c',
      name: 'C (GCC) - Calculation',
      code: '#include <stdio.h>\nint main() {\n    int a = 15, b = 25;\n    printf("Sum: %d\\n", a + b);\n    return 0;\n}',
      expectOk: true
    },
    {
      lang: 'cpp',
      name: 'C++ (G++) - Standard Output',
      code: '#include <iostream>\nint main() {\n    std::cout << "C++ Execution Successful!" << std::endl;\n    return 0;\n}',
      expectOk: true
    },
    {
      lang: 'java',
      name: 'Java (OpenJDK) - Main Class',
      code: 'public class Solution {\n    public static void main(String[] args) {\n        System.out.println("Java Piston Success!");\n    }\n}',
      expectOk: true
    },
    {
      lang: 'csharp',
      name: 'C# (Dotnet/Mono) - Console.WriteLine',
      code: 'using System;\nclass Program {\n    static void Main() {\n        Console.WriteLine("C# Piston Success!");\n    }\n}',
      expectOk: true
    },
    {
      lang: 'c',
      name: 'C Syntax Error Handling (Detect line)',
      code: '#include <stdio.h>\nint main() {\n    printf("Missing semicolon")\n    return 0;\n}',
      expectOk: false
    }
  ];

  for (const tc of testCases) {
    process.stdout.write(`Testing [${tc.lang.toUpperCase()}] ${tc.name}... `);
    const result = await runPiston(tc.code, tc.lang);
    if (result.ok === tc.expectOk) {
      console.log('PASS');
      if (result.ok) {
        console.log(`  -> Output: ${JSON.stringify(result.output.trim())}`);
      } else {
        console.log(`  -> Caught Expected Error: Line ${result.line || 'N/A'}`);
      }
    } else {
      console.log('FAIL');
      console.log('  -> Result:', result);
    }
    console.log('');
  }
}

module.exports = { runPiston, LANGUAGE_CONFIG };

if (require.main === module) {
  runTests();
}

