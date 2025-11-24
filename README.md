# Spira xUnit Integration (Node.js)

This is a Node.js version of the Spira xUnit integration that reads [xUnit](https://en.wikipedia.org/wiki/XUnit) XML files and imports the test results into Spira.

## Installation

First, install the required dependencies:

```bash
npm install
```

## Configuration

Create a `spira.cfg` file in your project root with the same format as the Python version:

```cfg
[credentials]
url = http://localhost/spira
username = administrator
token = {XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX}
project_id = 1
release_id = 5
test_set_id = 1
create_build = true

[test_cases]
LIS.Registration.registration1 = 2
LIS.Registration.registration2 = 3
# ... more test case mappings

[test_sets]
LIS.Registration = 2
LIS.Authentication = 5
# ... more test set mappings
```

## Usage

Run the script with your xUnit XML file:

```bash
node spira-xunit-reader.js <xml-file> [config-file]
```

Examples:

```bash
node spira-xunit-reader.js samples/junit-basic.xml spira.cfg
node spira-xunit-reader.js samples/junit-complete.xml spira.cfg
```

If no arguments are provided, it defaults to `xunit.xml` and `spira.cfg`.

## Features

This Node.js version supports all the same features as the Python version:

- Parse xUnit/JUnit XML test results
- Map test cases to Spira test cases
- Map test suites to Spira test sets
- Create builds in Spira
- Upload file attachments
- Link URL attachments
- Handle test failures, errors, warnings, and skipped tests
- Capture system output and error streams
- Support for test properties and assertions

## Dependencies

- `axios` - HTTP client for API requests
- `xml2js` - XML parser

## License

Same as the Python version - see LICENSE file.
