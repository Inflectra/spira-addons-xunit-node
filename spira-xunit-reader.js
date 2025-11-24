#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const xml2js = require('xml2js');

const RUNNER_NAME = 'xUnit (Node.js)';

class SpiraConfig {
    constructor(configFile) {
        this.url = '';
        this.username = '';
        this.token = '';
        this.project_id = -1;
        this.release_id = -1;
        this.test_set_id = -1;
        this.create_build = false;
        this.test_case_ids = {};
        this.test_set_ids = {};
        
        this.loadConfig(configFile);
    }

    loadConfig(configFile) {
        const content = fs.readFileSync(configFile, 'utf-8');
        const lines = content.split('\n');
        let currentSection = '';

        for (let line of lines) {
            line = line.trim();
            if (!line || line.startsWith('#')) continue;

            if (line.startsWith('[') && line.endsWith(']')) {
                currentSection = line.slice(1, -1);
                continue;
            }

            const [key, ...valueParts] = line.split('=');
            if (!key || valueParts.length === 0) continue;

            const trimmedKey = key.trim();
            const value = valueParts.join('=').trim();

            if (currentSection === 'credentials') {
                if (trimmedKey === 'create_build') {
                    this.create_build = value.toLowerCase() === 'true';
                } else if (trimmedKey === 'project_id' || trimmedKey === 'release_id' || trimmedKey === 'test_set_id') {
                    this[trimmedKey] = parseInt(value);
                } else {
                    this[trimmedKey] = value;
                }
            } else if (currentSection === 'test_cases') {
                this.test_case_ids[trimmedKey.toLowerCase()] = parseInt(value);
            } else if (currentSection === 'test_sets') {
                this.test_set_ids[trimmedKey.toLowerCase()] = parseInt(value);
            }
        }
    }
}

class SpiraDocument {
    constructor(projectId, attachmentTypeId, testRunId, filenameOrUrl, versionName) {
        this.projectId = projectId;
        this.attachmentTypeId = attachmentTypeId;
        this.testRunId = testRunId;
        this.filenameOrUrl = filenameOrUrl;
        this.versionName = versionName;
    }

    async post(spiraUrl, username, token, binaryData = null) {
        const restUrl = '/Services/v6_0/RestService.svc/';
        const endpoint = this.attachmentTypeId === 1 && binaryData
            ? `projects/${this.projectId}/documents/file`
            : `projects/${this.projectId}/documents/url`;

        const url = `${spiraUrl}${restUrl}${endpoint}`;
        
        const body = {
            ProjectId: this.projectId,
            AttachmentTypeId: this.attachmentTypeId,
            FilenameOrUrl: this.filenameOrUrl,
            CurrentVersion: this.versionName,
            AttachedArtifacts: [{
                ArtifactId: this.testRunId,
                ArtifactTypeId: 5
            }]
        };

        if (this.attachmentTypeId === 1 && binaryData) {
            body.BinaryData = binaryData;
        }

        try {
            const response = await axios.post(url, body, {
                params: { username, 'api-key': token },
                headers: {
                    'accept': 'application/json',
                    'Content-Type': 'application/json',
                    'User-Agent': RUNNER_NAME
                }
            });
            return response.data.AttachmentId;
        } catch (error) {
            if (error.response?.status === 404) {
                console.log(`Unable to find a matching Spira test run of id TR:${this.testRunId}, so not able to post result`);
            } else {
                console.log(`Unable to create document due to HTTP error: ${error.message}`);
            }
            return null;
        }
    }
}

class SpiraBuild {
    constructor(projectId, releaseId, buildStatusId, name, description = '') {
        this.projectId = projectId;
        this.releaseId = releaseId;
        this.buildStatusId = buildStatusId;
        this.name = name;
        this.description = description;
    }

    async post(spiraUrl, username, token) {
        const restUrl = '/Services/v6_0/RestService.svc/';
        const url = `${spiraUrl}${restUrl}projects/${this.projectId}/releases/${this.releaseId}/builds`;

        const body = {
            ProjectId: this.projectId,
            BuildStatusId: this.buildStatusId,
            ReleaseId: this.releaseId,
            Name: this.name,
            Description: this.description
        };

        try {
            const response = await axios.post(url, body, {
                params: { username, 'api-key': token },
                headers: {
                    'accept': 'application/json',
                    'Content-Type': 'application/json',
                    'User-Agent': RUNNER_NAME
                }
            });
            return response.data.BuildId;
        } catch (error) {
            if (error.response?.status === 404) {
                console.log(`Unable to find a matching Spira release of id RL:${this.releaseId}, so not able to post result`);
            } else {
                console.log(`Unable to create build due to HTTP error: ${error.message}`);
            }
            return null;
        }
    }
}

class SpiraTestRun {
    constructor(projectId, testCaseId, testName, stackTrace, statusId, startTime, endTime, 
                message = '', releaseId = -1, testSetId = -1, assertCount = 0, buildId = -1) {
        this.projectId = projectId;
        this.testCaseId = testCaseId;
        this.testName = testName;
        this.stackTrace = stackTrace;
        this.statusId = statusId;
        this.startTime = startTime;
        this.endTime = endTime;
        this.message = message;
        this.releaseId = releaseId;
        this.testSetId = testSetId;
        this.assertCount = assertCount;
        this.buildId = buildId;
    }

    async post(spiraUrl, username, token) {
        const restUrl = '/Services/v6_0/RestService.svc/';
        const url = `${spiraUrl}${restUrl}projects/${this.projectId}/test-runs/record`;

        const body = {
            TestRunFormatId: 1,
            StartDate: this.startTime.toISOString().replace(/\.\d{3}Z$/, 'Z'),
            EndDate: this.endTime.toISOString().replace(/\.\d{3}Z$/, 'Z'),
            RunnerName: RUNNER_NAME,
            RunnerTestName: this.testName,
            RunnerMessage: this.message,
            RunnerStackTrace: this.stackTrace,
            RunnerAssertCount: this.assertCount,
            TestCaseId: this.testCaseId,
            ExecutionStatusId: this.statusId
        };

        if (this.releaseId !== -1) {
            body.ReleaseId = this.releaseId;
            if (this.buildId !== -1) {
                body.BuildId = this.buildId;
            }
        }

        if (this.testSetId !== -1) {
            body.TestSetId = this.testSetId;
        }

        try {
            const response = await axios.post(url, body, {
                params: { username, 'api-key': token },
                headers: {
                    'accept': 'application/json',
                    'Content-Type': 'application/json',
                    'User-Agent': RUNNER_NAME
                }
            });
            return response.data.TestRunId;
        } catch (error) {
            if (error.response?.status === 404) {
                console.log(`Unable to find a matching Spira test case of id TC:${this.testCaseId}, so not able to post result`);
            } else {
                console.log(`Unable to send results due to HTTP error: ${error.message}`);
            }
            return -1;
        }
    }
}

class SpiraResultsParser {
    constructor(configFile = 'spira.cfg') {
        this.testResults = [];
        this.config = new SpiraConfig(configFile);
        this.attachmentRegex = /\[\[ATTACHMENT\|([a-zA-Z0-9_\/\\.]+)\]\]/g;
    }

    readAttachmentFile(reportFile, filepath) {
        try {
            const reportFolder = path.dirname(reportFile);
            const fullPath = path.join(reportFolder, filepath);
            const fileData = fs.readFileSync(fullPath);
            const base64Data = fileData.toString('base64');
            return {
                filename: filepath,
                binary_data: base64Data
            };
        } catch (error) {
            console.log(`Unable to read image file '${filepath}' due to error '${error.message}', so skipping attachment.\n`);
            return null;
        }
    }

    async parseResults(reportFile) {
        const xmlContent = fs.readFileSync(reportFile, 'utf-8');
        const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
        
        const result = await parser.parseStringPromise(xmlContent);
        const testsuites = result.testsuites || result.testsuite;
        const testsuitesRoot = result.testsuites || {};

        this.processTestSuites(testsuites, reportFile);

        const spiraResults = new SpiraPostResults(this.config);
        await spiraResults.sendResults(this.testResults, testsuitesRoot);
    }

    processTestSuites(node, reportFile, suiteName = '') {
        if (!node) return;

        const suites = Array.isArray(node.testsuite) ? node.testsuite : (node.testsuite ? [node.testsuite] : [node]);

        for (const suite of suites) {
            const currentSuiteName = suite.name || suiteName;
            
            if (suite.testsuite) {
                this.processTestSuites(suite, reportFile, currentSuiteName);
            }

            if (suite.testcase) {
                const testcases = Array.isArray(suite.testcase) ? suite.testcase : [suite.testcase];
                
                for (const testcase of testcases) {
                    this.processTestCase(testcase, currentSuiteName, reportFile);
                }
            }
        }
    }

    processTestCase(testcase, suiteName, reportFile) {
        const testName = testcase.name;
        const className = testcase.classname;
        const elapsedTime = parseFloat(testcase.time || 0);
        const fullName = `${className}.${testName}`;

        const testCaseId = this.config.test_case_ids[fullName.toLowerCase()];
        
        if (!testCaseId) {
            console.log(`Unable to find Spira id tag for test case '${fullName}', so skipping this test case.`);
            return;
        }

        const testSetId = this.config.test_set_ids[suiteName.toLowerCase()] || -1;

        let executionStatusId = 2; // Passed
        let message = 'Success';
        let details = 'Nothing Reported\n';
        let assertCount = 0;

        if (testcase.failure) {
            message = testcase.failure.message || 'Test Failed';
            details = testcase.failure._ || testcase.failure;
            executionStatusId = 1; // Fail
            assertCount = 1;
        } else if (testcase.warning) {
            message = testcase.warning.message || 'Test Warning';
            details = testcase.warning._ || testcase.warning;
            executionStatusId = 6; // Warning
            assertCount = 1;
        } else if (testcase.error) {
            message = testcase.error.message || 'Test Error';
            details = testcase.error._ || testcase.error;
            executionStatusId = 5; // Blocked
            assertCount = 1;
        } else if (testcase.skipped) {
            message = testcase.skipped.message || 'Test Skipped';
            details = testcase.skipped._ || testcase.skipped || '';
            executionStatusId = 4; // N/A
            assertCount = 1;
        }

        if (testcase.assertions) {
            assertCount = parseInt(testcase.assertions);
        }

        const attachments = [];
        const links = [];

        if (testcase['system-out']) {
            const systemOut = testcase['system-out'];
            details += `System Out: ${systemOut}\n`;
            this.extractAttachments(systemOut, reportFile, attachments);
        }

        if (testcase['system-err']) {
            const systemErr = testcase['system-err'];
            details += `System Err: ${systemErr}\n`;
            this.extractAttachments(systemErr, reportFile, attachments);
        }

        if (testcase.properties && testcase.properties.property) {
            const properties = Array.isArray(testcase.properties.property) 
                ? testcase.properties.property 
                : [testcase.properties.property];

            for (const prop of properties) {
                const propName = prop.name;
                const propValue = prop.value || prop._ || '';
                details += `- ${propName}=${propValue}\n`;

                if (propName.startsWith('attachment')) {
                    if (propValue.startsWith('http')) {
                        links.push({ url: propValue });
                    } else {
                        const attachment = this.readAttachmentFile(reportFile, propValue);
                        if (attachment) attachments.push(attachment);
                    }
                }
            }
        }

        this.testResults.push({
            test_case_id: testCaseId,
            name: fullName,
            execution_status_id: executionStatusId,
            stack_trace: details,
            message: message,
            duration_seconds: elapsedTime,
            assert_count: assertCount,
            test_set_id: testSetId,
            attachments: attachments,
            links: links
        });
    }

    extractAttachments(text, reportFile, attachments) {
        const matches = text.matchAll(this.attachmentRegex);
        for (const match of matches) {
            const filepath = match[1];
            const attachment = this.readAttachmentFile(reportFile, filepath);
            if (attachment) attachments.push(attachment);
        }
    }
}

class SpiraPostResults {
    constructor(config) {
        this.config = config;
    }

    async sendResults(testResults, testsuites) {
        if (!this.config.url) {
            console.log('Unable to report test results back to Spira since URL in configuration is empty');
            return;
        }

        let buildId = -1;
        if (this.config.create_build) {
            console.log(`Creating new build in Spira at URL '${this.config.url}'.`);

            let buildStatusId = 2; // Passed
            for (const testResult of testResults) {
                if (testResult.execution_status_id === 1) {
                    buildStatusId = 1; // Failed
                    break;
                }
            }

            const currentTime = new Date();
            let name = `${RUNNER_NAME} Build ${currentTime.toISOString()}`;
            let description = '';

            if (testsuites.name) name = `${testsuites.name} Build ${currentTime.toISOString()}`;
            if (testsuites.tests) description += `# Tests: ${testsuites.tests}\n`;
            if (testsuites.failures) description += `# Failures: ${testsuites.failures}\n`;
            if (testsuites.errors) description += `# Errors: ${testsuites.errors}\n`;
            if (testsuites.skipped) description += `# Skipped: ${testsuites.skipped}\n`;
            if (testsuites.assertions) description += `# Assertions: ${testsuites.assertions}\n`;

            const spiraBuild = new SpiraBuild(
                this.config.project_id,
                this.config.release_id,
                buildStatusId,
                name,
                description
            );
            buildId = await spiraBuild.post(this.config.url, this.config.username, this.config.token);
        }

        console.log(`Sending test results to Spira at URL '${this.config.url}'.`);
        
        try {
            let successCount = 0;
            for (const testResult of testResults) {
                const currentTime = new Date();
                const isError = await this.sendResult(testResult, currentTime, buildId);
                if (!isError) successCount++;
            }

            console.log(`Successfully reported ${successCount} test cases to Spira.\n`);
        } catch (error) {
            console.log(`Unable to report test cases to Spira due to error '${error.message}'.\n`);
        }
    }

    async sendResult(testResult, currentTime, buildId) {
        try {
            const testSetId = testResult.test_set_id > 0 
                ? testResult.test_set_id 
                : this.config.test_set_id;

            const startTime = new Date(currentTime.getTime() - testResult.duration_seconds * 1000);
            
            const testRun = new SpiraTestRun(
                this.config.project_id,
                testResult.test_case_id,
                testResult.name,
                testResult.stack_trace,
                testResult.execution_status_id,
                startTime,
                currentTime,
                testResult.message,
                this.config.release_id,
                testSetId,
                testResult.assert_count,
                buildId
            );

            const testRunId = await testRun.post(this.config.url, this.config.username, this.config.token);
            const isError = testRunId < 1;

            if (!isError) {
                if (testResult.attachments) {
                    for (const attachment of testResult.attachments) {
                        const spiraDocument = new SpiraDocument(
                            this.config.project_id,
                            1,
                            testRunId,
                            attachment.filename,
                            '1.0'
                        );
                        await spiraDocument.post(
                            this.config.url,
                            this.config.username,
                            this.config.token,
                            attachment.binary_data
                        );
                    }
                }

                if (testResult.links) {
                    for (const link of testResult.links) {
                        const spiraDocument = new SpiraDocument(
                            this.config.project_id,
                            2,
                            testRunId,
                            link.url,
                            '1.0'
                        );
                        await spiraDocument.post(this.config.url, this.config.username, this.config.token);
                    }
                }
            }

            return isError;
        } catch (error) {
            console.log(`Unable to report test case '${testResult.name}' to Spira due to error '${error.message}'.\n`);
            return true;
        }
    }
}

// Main execution
if (require.main === module) {
    const args = process.argv.slice(2);
    const reportFile = args[0] || 'xunit.xml';
    const configFile = args[1] || 'spira.cfg';

    const parser = new SpiraResultsParser(configFile);
    parser.parseResults(reportFile).catch(error => {
        console.error('Error parsing results:', error.message);
        process.exit(1);
    });
}

module.exports = { SpiraResultsParser, SpiraPostResults, SpiraTestRun, SpiraBuild, SpiraDocument, SpiraConfig };
